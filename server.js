const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let _fetchFn;
let _fetchInProgress = false;
let _lastFetchStart = 0;

let dbPool = null;
let dbReady = false;

async function getFetch() {
    if (_fetchFn) return _fetchFn;
    if (typeof globalThis.fetch === 'function') {
        _fetchFn = globalThis.fetch.bind(globalThis);
        return _fetchFn;
    }

    try {
        const mod = await import('node-fetch');
        _fetchFn = (mod && mod.default ? mod.default : mod);
        return _fetchFn;
    } catch (e) {
        try {
            const mod = require('node-fetch');
            _fetchFn = (mod && mod.default ? mod.default : mod);
            return _fetchFn;
        } catch (e2) {
            throw new Error('fetch is not available (no global fetch and cannot load node-fetch)');
        }
    }
}

async function fetchJson(url, { timeoutMs = 15000 } = {}) {
    const fetchFn = await getFetch();
    const hasAbortController = typeof AbortController !== 'undefined';
    const controller = hasAbortController ? new AbortController() : null;
    const timeout = hasAbortController ? setTimeout(() => controller.abort(), timeoutMs) : null;

    const hardTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`TIMEOUT ${timeoutMs}ms`)), timeoutMs + 250);
    });

    try {
        const res = await Promise.race([
            fetchFn(url, controller ? { signal: controller.signal } : undefined),
            hardTimeout
        ]);
        if (!res || !res.ok) {
            const status = res ? res.status : 'NO_RESPONSE';
            throw new Error(`HTTP ${status}`);
        }
        return await Promise.race([res.json(), hardTimeout]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

async function fetchAndSaveData() {
    if (_fetchInProgress) {
        const ageMs = Date.now() - _lastFetchStart;
        if (ageMs < 60000) {
            console.log('Pobieranie już trwa, pomijam cykl.');
            return;
        }
        console.log('Poprzednie pobieranie trwa zbyt długo, resetuję blokadę.');
        _fetchInProgress = false;
    }

    _fetchInProgress = true;
    _lastFetchStart = Date.now();

    const guardTimer = setTimeout(() => {
        if (_fetchInProgress) {
            console.log('Pobieranie przekroczyło limit czasu, zwalniam blokadę.');
            _fetchInProgress = false;
        }
    }, 70000);

    try {
        console.log('Rozpoczynam pobieranie danych z API...');

        const t = Date.now();
        const vehicleUrl = `https://files.cloudgdansk.pl/d/otwarte-dane/ztm/baza-pojazdow.json?v=2&t=${t}`;
        const gpsUrl = `https://ckan2.multimediagdansk.pl/gpsPositions?v=2&t=${t}`;
        const categoriesUrl = `https://ckan.multimediagdansk.pl/dataset/c24aa637-3619-4dc2-a171-a23eec8f2172/resource/8b5175e6-7621-4149-a9f8-a29696c73d8d/download/kategorie.json?t=${t}`;

        let vehicleDatabase = null;
        try {
            console.log('Pobieranie bazy pojazdów...');
            vehicleDatabase = await fetchJson(vehicleUrl, { timeoutMs: 20000 });
        } catch (e) {
            console.log('Nie udało się pobrać bazy pojazdów:', e && e.message ? e.message : e);
        }

        let gpsData = null;
        try {
            console.log('Pobieranie pozycji GPS...');
            gpsData = await fetchJson(gpsUrl, { timeoutMs: 20000 });
        } catch (e) {
            console.log('Nie udało się pobrać GPS:', e && e.message ? e.message : e);
        }

        let categories = [];
        try {
            console.log('Pobieranie kategorii linii...');
            const cat = await fetchJson(categoriesUrl, { timeoutMs: 20000 });
            categories = Array.isArray(cat) ? cat : [];
        } catch (e) {
            console.log('Nie udało się pobrać kategorii:', e && e.message ? e.message : e);
        }

        const vehicles = processAllData(vehicleDatabase, gpsData, categories);

        const completeData = {
            vehicles,
            vehicleDatabase,
            gpsData,
            categories,
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync(path.join(__dirname, 'pojazdy.json'), JSON.stringify(completeData, null, 2));

        try {
            await upsertHistory(getTodayDateString(), completeData);
        } catch (e) {
            console.log('Nie udało się zapisać danych do bazy.');
        }

        console.log('Kompletne dane zapisano na dysku:', new Date().toLocaleTimeString());
        console.log('vehicles:', Array.isArray(vehicles) ? vehicles.length : 0);
        console.log('Połączone dane (aktywne + historyczne):', vehicles.length);
    } catch (e) {
        console.error('Błąd pobierania danych:', e && e.message ? e.message : e);
    } finally {
        clearTimeout(guardTimer);
        _fetchInProgress = false;
    }
}

function processAndMergeData(vehicleDatabase, gpsData, categoryData) {
    const now = new Date();
    let mergedData = [];

    let existingData = [];
    try {
        const existingFilePath = path.join(__dirname, 'pojazdy.json');
        if (fs.existsSync(existingFilePath)) {
            const existingFile = JSON.parse(fs.readFileSync(existingFilePath, 'utf8'));
            existingData = existingFile.vehicles || [];
            console.log('Wczytano istniejących pojazdów:', existingData.length);
        }
    } catch (error) {
        console.log('Nie udało się wczytać istniejących danych:', error.message);
    }

    const currentVehicles = [];
    const gpsVehicles = gpsData && Array.isArray(gpsData.vehicles) ? gpsData.vehicles : [];
    if (gpsVehicles.length > 0) {
        gpsVehicles.forEach((gps) => {
            const vehicleId = gps.vehicleCode || gps.VehicleCode || gps.VehicleID;
            if (!vehicleId) return;

            let agency = 'PKS Gdańsk';
            if (vehicleId >= 1000 && vehicleId < 3000) {
                agency = 'GAIT';
            } else if (vehicleId >= 8000 && vehicleId < 9000) {
                agency = 'ReloBus';
            } else if (vehicleId >= 9000) {
                agency = 'PKS Gdańsk';
            }

            let model = "Nieznany";
            let type = "Autobus";

            const dbResults = vehicleDatabase && Array.isArray(vehicleDatabase.results) ? vehicleDatabase.results : [];
            if (dbResults.length > 0) {
                const vehicleInfo = dbResults.find(v => (
                    v && (v.vehicleCode === vehicleId || v.VehicleCode === vehicleId || v.VehicleID === vehicleId)
                ));
                if (vehicleInfo) {
                    const brand = vehicleInfo.brand || '';
                    const modelName = vehicleInfo.model || '';
                    model = `${brand} ${modelName}`.trim() || 'Nieznany';
                    type = vehicleInfo.transportationType || 'Autobus';
                }
            }

            const startTime = gps.scheduledTripStartTime ? new Date(gps.scheduledTripStartTime) : null;
            const currentTime = new Date();
            let routeTime = '---';

            if (startTime) {
                if (startTime.getTime() > 0 && startTime.getFullYear() > 2000) {
                    const localStartTime = new Date(startTime.getTime());
                    const localCurrentTime = new Date();

                    const startHour = localStartTime.getHours().toString().padStart(2, '0');
                    const startMin = localStartTime.getMinutes().toString().padStart(2, '0');
                    const currentHour = currentTime.getHours().toString().padStart(2, '0');
                    const currentMin = currentTime.getMinutes().toString().padStart(2, '0');
                    routeTime = `${startHour}:${startMin} - ${currentHour}:${currentMin}`;
                } else {
                    const timeString = startTime.toString();
                    const timeMatch = timeString.match(/(\d{1,2}):(\d{2})/);
                    if (timeMatch) {
                        const startHour = timeMatch[1];
                        const startMin = timeMatch[2];
                        const currentHour = currentTime.getHours().toString().padStart(2, '0');
                        const currentMin = currentTime.getMinutes().toString().padStart(2, '0');
                        routeTime = `${startHour}:${startMin} - ${currentHour}:${currentMin}`;
                    } else {
                        const currentHour = currentTime.getHours().toString().padStart(2, '0');
                        const currentMin = currentTime.getMinutes().toString().padStart(2, '0');
                        routeTime = `--- - ${currentHour}:${currentMin}`;
                    }
                }
            }

            currentVehicles.push({
                id: vehicleId.toString(),
                agency: agency,
                model: model,
                brigade: gps.vehicleService || '---',
                timestamp: gps.generated || new Date().toISOString(),
                isActive: true,
                line: gps.routeShortName || '',
                type: type,
                routeTime: routeTime,
                speed: gps.speed || 0,
                delay: gps.delay || 0,
                lat: gps.lat,
                lon: gps.lon,
                source: 'server'
            });
        });
    }

    console.log('Aktualne pojazdy z GPS:', currentVehicles.length);

    const currentVehicleIds = new Set(currentVehicles.map(v => v.id));
    const existingVehicleIds = new Set(existingData.map(v => v.id));

    currentVehicles.forEach(currentVehicle => {
        const existingIndex = existingData.findIndex(v => v.id === currentVehicle.id);

        if (existingIndex !== -1) {
            existingData[existingIndex] = {
                ...existingData[existingIndex],
                ...currentVehicle,
                timestamp: existingData[existingIndex].timestamp &&
                    new Date(existingData[existingIndex].timestamp) < new Date(currentVehicle.timestamp) ?
                    existingData[existingIndex].timestamp : currentVehicle.timestamp
            };
        } else {
            mergedData.push(currentVehicle);
        }
    });

    existingData.forEach(existingVehicle => {
        if (!currentVehicleIds.has(existingVehicle.id)) {
            mergedData.push({
                ...existingVehicle,
                isActive: false,
                timestamp: new Date().toISOString()
            });
        }
    });

    existingData.forEach(existingVehicle => {
        if (currentVehicleIds.has(existingVehicle.id)) {
            mergedData.push(existingVehicle);
        }
    });

    const uniqueVehicles = [];
    const seenIds = new Set();

    mergedData.forEach(vehicle => {
        if (!seenIds.has(vehicle.id)) {
            seenIds.add(vehicle.id);
            uniqueVehicles.push(vehicle);
        }
    });

    uniqueVehicles.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    console.log('Połączone dane:', uniqueVehicles.length);
    console.log('   - Aktywne:', uniqueVehicles.filter(v => v.isActive).length);
    console.log('   - Nieaktywne:', uniqueVehicles.filter(v => !v.isActive).length);

    return uniqueVehicles;
}

function processAllData(vehicleDatabase, gpsData, categoryData) {
    try {
        const safeCategories = Array.isArray(categoryData) ? categoryData : [];
        void safeCategories;
        return processAndMergeData(vehicleDatabase, gpsData, safeCategories);
    } catch (e) {
        console.log('Błąd w processAllData, zwracam bezpieczne dane:', e && e.message ? e.message : e);
        return [];
    }
}

function checkExistingData() {
    try {
        const filePath = path.join(__dirname, 'pojazdy.json');
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (data && data.vehicles && data.vehicles.length > 0) {
                const lastUpdate = data.lastUpdate ? new Date(data.lastUpdate) : new Date(0);
                const now = new Date();
                const minutesSinceUpdate = (now - lastUpdate) / (1000 * 60);

                console.log('Znaleziono istniejące dane:');
                console.log(`   - Pojazdów: ${data.vehicles.length}`);
                console.log(`   - Aktywnych: ${data.vehicles.filter(v => v.isActive).length}`);
                console.log(`   - Ostatnia aktualizacja: ${lastUpdate.toLocaleString('pl-PL')}`);
                console.log(`   - Minut od aktualizacji: ${minutesSinceUpdate.toFixed(1)}`);

                if (minutesSinceUpdate < 5) {
                    console.log('Dane są świeże, pomijam pierwsze pobieranie');
                    return true;
                } else {
                    console.log('Dane są przestarzałe, pobieram świeże');
                    return false;
                }
            }
        }
    } catch (error) {
        console.log('Nie udało się sprawdzić istniejących danych:', error.message);
    }

    console.log('Brak istniejących danych, pobieram od razu');
    return false;
}

function initializeServer() {
    console.log('Inicjalizacja serwera ZTM Tracker...');

    const hasFreshData = checkExistingData();

    if (!hasFreshData) {
        console.log('Pierwsze pobieranie danych...');
        fetchAndSaveData();
    } else {
        console.log('Ustawiam interwał 2-minutowy...');
        console.log('Serwer gotowy do pracy na istniejących danych');
    }

    setInterval(() => {
        console.log('Cykliczne pobieranie danych (co 2 minuty)...');
        fetchAndSaveData();
    }, 120000);
}

function isValidDateParam(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function getTodayDateString() {
    return new Date().toISOString().slice(0, 10);
}

async function initDb() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        dbReady = false;
        dbPool = null;
        console.log('Nie ustawiono DATABASE_URL, pomijam inicjalizację bazy danych.');
        return;
    }

    dbPool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await dbPool.query('select 1');
        await dbPool.query(
            'create table if not exists history (date date primary key, payload jsonb not null)'
        );
        dbReady = true;
        console.log('Połączenie z bazą PostgreSQL gotowe.');
    } catch (e) {
        dbReady = false;
        console.log('Nie udało się połączyć z bazą PostgreSQL.');
    }
}

async function upsertHistory(date, payload) {
    if (!dbReady || !dbPool) {
        throw new Error('Baza danych nie jest skonfigurowana.');
    }
    const payloadJson = JSON.stringify(payload);
    await dbPool.query(
        'insert into history(date, payload) values ($1, $2::jsonb) on conflict (date) do update set payload = excluded.payload',
        [date, payloadJson]
    );
}

app.get('/api/historical/:date', async (req, res) => {
    try {
        const date = req.params.date;
        if (!isValidDateParam(date)) {
            res.status(400).json({ error: 'Nieprawidłowy format daty. Użyj YYYY-MM-DD.' });
            return;
        }
        if (!dbReady || !dbPool) {
            res.status(503).json({ error: 'Baza danych nie jest skonfigurowana.' });
            return;
        }

        const result = await dbPool.query('select payload from history where date = $1', [date]);
        if (!result.rows || result.rows.length === 0) {
            res.status(404).json({ error: `Brak danych historycznych dla dnia ${date}.` });
            return;
        }

        res.json(result.rows[0].payload);
    } catch (e) {
        res.status(500).json({ error: 'Błąd pobierania danych historycznych.' });
    }
});

app.post('/api/historical/:date', async (req, res) => {
    try {
        const date = req.params.date;
        if (!isValidDateParam(date)) {
            res.status(400).json({ error: 'Nieprawidłowy format daty. Użyj YYYY-MM-DD.' });
            return;
        }
        if (!dbReady || !dbPool) {
            res.status(503).json({ error: 'Baza danych nie jest skonfigurowana.' });
            return;
        }

        const payload = req.body;
        await upsertHistory(date, payload);
        res.json({ message: `Zapisano dane historyczne dla dnia ${date}.` });
    } catch (e) {
        res.status(500).json({ error: 'Błąd zapisu danych historycznych.' });
    }
});

app.delete('/api/historical/:date', async (req, res) => {
    try {
        const date = req.params.date;
        if (!isValidDateParam(date)) {
            res.status(400).json({ error: 'Nieprawidłowy format daty. Użyj YYYY-MM-DD.' });
            return;
        }
        if (!dbReady || !dbPool) {
            res.status(503).json({ error: 'Baza danych nie jest skonfigurowana.' });
            return;
        }

        const result = await dbPool.query('delete from history where date = $1', [date]);
        if (!result || result.rowCount === 0) {
            res.status(404).json({ error: `Brak danych historycznych dla dnia ${date}.` });
            return;
        }

        res.json({ message: `Usunięto dane historyczne dla dnia ${date}.` });
    } catch (e) {
        res.status(500).json({ error: 'Błąd usuwania danych historycznych.' });
    }
});

async function startServer() {
    await initDb();
    initializeServer();
    app.listen(PORT, () => {
        console.log(`🌐 Serwer działa na porcie ${PORT}`);
    });
}

startServer();