const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

let _fetchFn;
let _fetchInProgress = false;
let _lastFetchStart = 0;

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

initializeServer();

function checkAndCreateDailyBackup() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    if (currentHour === 0 && currentMinute <= 5) {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const backupDate = yesterday.toISOString().split('T')[0];
        const backupFileName = `daily_backup_${backupDate}.json`;
        const backupFilePath = path.join(__dirname, backupFileName);

        if (!fs.existsSync(backupFilePath)) {
            createDailyBackup(backupDate, backupFilePath);
        }
    }
}

function createDailyBackup(date, filePath) {
    try {
        console.log(`Robienie zrzutu dziennego dla dnia: ${date}`);

        const currentDataPath = path.join(__dirname, 'pojazdy.json');
        if (!fs.existsSync(currentDataPath)) {
            console.log('Brak danych do zrzutu dziennego');
            return;
        }

        const currentData = JSON.parse(fs.readFileSync(currentDataPath, 'utf8'));

        const dailyBackup = {
            date: date,
            backupTime: new Date().toISOString(),
            summary: {
                totalVehicles: currentData.vehicles ? currentData.vehicles.length : 0,
                activeVehicles: currentData.vehicles ? currentData.vehicles.filter(v => v.isActive).length : 0,
                inactiveVehicles: currentData.vehicles ? currentData.vehicles.filter(v => !v.isActive).length : 0,
                agencies: currentData.vehicles ? [...new Set(currentData.vehicles.map(v => v.agency))] : [],
                lastUpdate: currentData.lastUpdate || new Date().toISOString()
            },
            data: {
                vehicles: currentData.vehicles || [],
                vehicleDatabase: currentData.vehicleDatabase || null,
                gpsData: currentData.gpsData || null,
                categories: currentData.categories || []
            },
            statistics: generateDailyStatistics(currentData.vehicles || []),
            metadata: {
                backupType: 'daily_midnight_backup',
                version: '1.0',
                source: 'ztm_tracker_server'
            }
        };

        fs.writeFileSync(filePath, JSON.stringify(dailyBackup, null, 2));

        console.log(`Zrzut dzienny zapisany: ${backupFileName}`);
        console.log(`Podsumowanie: ${dailyBackup.summary.totalVehicles} pojazdów (${dailyBackup.summary.activeVehicles} aktywnych)`);

        generateDailyReport(date, dailyBackup);

        cleanupOldBackups();
    } catch (error) {
        console.error('Błąd tworzenia zrzutu dziennego:', error.message);
    }
}

function generateDailyStatistics(vehicles) {
    if (!vehicles || vehicles.length === 0) {
        return {
            totalRecords: 0,
            agencies: {},
            vehicleTypes: {},
            hourlyActivity: {},
            averageRoutesPerVehicle: 0
        };
    }

    const stats = {
        totalRecords: vehicles.length,
        agencies: {},
        vehicleTypes: {},
        hourlyActivity: {},
        averageRoutesPerVehicle: 0
    };

    vehicles.forEach(vehicle => {
        const agency = vehicle.agency || 'Nieznany';
        stats.agencies[agency] = (stats.agencies[agency] || 0) + 1;

        const type = vehicle.type || 'Nieznany';
        stats.vehicleTypes[type] = (stats.vehicleTypes[type] || 0) + 1;

        if (vehicle.timestamp) {
            const vehicleTime = new Date(vehicle.timestamp);
            const localHour = new Date(vehicleTime.getTime() - (vehicleTime.getTimezoneOffset() * 60000)).getHours();
            const hourKey = `${localHour.toString().padStart(2, '0')}:00`;
            stats.hourlyActivity[hourKey] = (stats.hourlyActivity[hourKey] || 0) + 1;
        }
    });

    const vehiclesWithLines = vehicles.filter(v => v.line && v.line !== '---');
    stats.averageRoutesPerVehicle = vehiclesWithLines.length > 0 ?
        (vehiclesWithLines.length / vehicles.length).toFixed(2) : 0;

    return stats;
}

function generateDailyReport(date, backupData) {
    try {
        const reportFileName = `daily_report_${date}.txt`;
        const reportFilePath = path.join(__dirname, reportFileName);

        const stats = backupData.statistics;
        const summary = backupData.summary;

        let report = `RAPORT DZIENNY - ZTM Gdańsk Tracker\n`;
        report += `=====================================\n`;
        report += `Data: ${date}\n`;
        report += `Czas zrzutu: ${new Date(backupData.backupTime).toLocaleString('pl-PL')}\n\n`;

        report += `PODSUMOWANIE:\n`;
        report += `------------\n`;
        report += `Łącznie pojazdów: ${summary.totalVehicles}\n`;
        report += `Aktywnych: ${summary.activeVehicles}\n`;
        report += `Nieaktywnych: ${summary.inactiveVehicles}\n`;
        report += `Średnia tras/pojazd: ${stats.averageRoutesPerVehicle}\n\n`;

        report += `PRZEWOŹNICY:\n`;
        report += `------------\n`;
        Object.entries(stats.agencies).forEach(([agency, count]) => {
            report += `${agency}: ${count} pojazdów (${((count / summary.totalVehicles) * 100).toFixed(1)}%)\n`;
        });

        report += `\nTYPY POJAZDÓW:\n`;
        report += `--------------\n`;
        Object.entries(stats.vehicleTypes).forEach(([type, count]) => {
            report += `${type}: ${count} pojazdów\n`;
        });

        report += `\nAKTYWNOŚĆ GODZINOWA (top 10):\n`;
        report += `---------------------------\n`;
        const sortedHours = Object.entries(stats.hourlyActivity)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10);

        sortedHours.forEach(([hour, count]) => {
            report += `${hour}: ${count} pojazdów\n`;
        });

        report += `\nOSTATNIA AKTUALIZACJA: ${summary.lastUpdate}\n`;
        report += `=====================================\n`;

        fs.writeFileSync(reportFilePath, report, 'utf8');
        console.log(`Raport dzienny zapisany: ${reportFileName}`);

    } catch (error) {
        console.error('Błąd generowania raportu dziennego:', error.message);
    }
}

function cleanupOldBackups() {
    try {
        const files = fs.readdirSync(__dirname);
        const backupFiles = files.filter(file =>
            file.startsWith('daily_backup_') && file.endsWith('.json')
        );

        backupFiles.sort();

        if (backupFiles.length > 30) {
            const filesToDelete = backupFiles.slice(0, backupFiles.length - 30);

            filesToDelete.forEach(file => {
                const filePath = path.join(__dirname, file);
                fs.unlinkSync(filePath);
                console.log(`Usunięto stary backup: ${file}`);
            });

            const reportFiles = files.filter(file =>
                file.startsWith('daily_report_') && file.endsWith('.txt')
            );
            reportFiles.sort();

            if (reportFiles.length > 30) {
                const reportsToDelete = reportFiles.slice(0, reportFiles.length - 30);
                reportsToDelete.forEach(file => {
                    const filePath = path.join(__dirname, file);
                    fs.unlinkSync(filePath);
                    console.log(`Usunięto stary raport: ${file}`);
                });
            }
        }

    } catch (error) {
        console.error('Błąd czyszczenia starych backupów:', error.message);
    }
}

setInterval(checkAndCreateDailyBackup, 5 * 60 * 1000);

app.get('/api/daily-backups', (req, res) => {
    try {
        const files = fs.readdirSync(__dirname);
        const backupFiles = files
            .filter(file => file.startsWith('daily_backup_') && file.endsWith('.json'))
            .sort()
            .reverse();

        const backups = backupFiles.map(file => {
            const filePath = path.join(__dirname, file);
            const stats = fs.statSync(filePath);
            const date = file.replace('daily_backup_', '').replace('.json', '');
            const backupFileName = `daily_backup_${date}.json`;
            const backupFilePath = path.join(__dirname, backupFileName);

            return {
                date: date,
                filename: file,
                size: stats.size,
                created: stats.birthtime.toISOString(),
                url: `/api/daily-backup/${date}`
            };
        });

        res.json({ backups: backups });

    } catch (error) {
        console.error('Błąd pobierania listy backupów:', error);
        res.status(500).json({ error: 'Błąd pobierania listy backupów' });
    }
});

app.get('/api/daily-backup/:date', (req, res) => {
    try {
        const date = req.params.date;
        const filename = `daily_backup_${date}.json`;
        const filePath = path.join(__dirname, filename);

        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).json({ error: `Backup dla dnia ${date} nie istnieje` });
        }

    } catch (error) {
        console.error('Błąd pobierania backupu:', error);
        res.status(500).json({ error: 'Błąd pobierania backupu' });
    }
});

app.get('/api/daily-reports', (req, res) => {
    try {
        const files = fs.readdirSync(__dirname);
        const reportFiles = files
            .filter(file => file.startsWith('daily_report_') && file.endsWith('.txt'))
            .sort()
            .reverse();

        const reports = reportFiles.map(file => {
            const filePath = path.join(__dirname, file);
            const stats = fs.statSync(filePath);
            const date = file.replace('daily_report_', '').replace('.txt', '');
            const reportFileName = `daily_report_${date}.txt`;
            const reportFilePath = path.join(__dirname, reportFileName);

            return {
                date: date,
                filename: file,
                size: stats.size,
                created: stats.birthtime.toISOString(),
                url: `/api/daily-report/${date}`
            };
        });

        res.json({ reports: reports });

    } catch (error) {
        console.error('Błąd pobierania listy raportów:', error);
        res.status(500).json({ error: 'Błąd pobierania listy raportów' });
    }
});

app.get('/api/all-backups-merged', (req, res) => {
    try {
        console.log('Łączenie wszystkich backupów dla zakładki nieaktywnych pojazdów...');

        const files = fs.readdirSync(__dirname);
        const backupFiles = files
            .filter(file => file.startsWith('daily_backup_') && file.endsWith('.json'))
            .sort();

        let allVehicles = [];
        let processedDates = [];

        backupFiles.forEach(file => {
            try {
                const filePath = path.join(__dirname, file);
                const backupData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

                if (backupData.data && backupData.data.vehicles) {
                    const vehiclesWithDate = backupData.data.vehicles.map(vehicle => ({
                        ...vehicle,
                        backupDate: backupData.date,
                        backupSource: 'daily_backup'
                    }));

                    allVehicles.push(...vehiclesWithDate);
                    processedDates.push(backupData.date);
                }
            } catch (error) {
                console.log(`Błąd przetwarzania backupu ${file}:`, error.message);
            }
        });

        try {
            const currentDataPath = path.join(__dirname, 'pojazdy.json');
            if (fs.existsSync(currentDataPath)) {
                const currentData = JSON.parse(fs.readFileSync(currentDataPath, 'utf8'));
                if (currentData.vehicles) {
                    const currentVehiclesWithDate = currentData.vehicles.map(vehicle => ({
                        ...vehicle,
                        backupDate: new Date().toISOString().split('T')[0],
                        backupSource: 'current'
                    }));
                    allVehicles.push(...currentVehiclesWithDate);
                }
            }
        } catch (error) {
            console.log(`Błąd wczytywania aktualnych danych:`, error.message);
        }

        const uniqueVehicles = [];
        const seenVehicles = new Map();

        allVehicles.forEach(vehicle => {
            const key = `${vehicle.id}_${vehicle.agency}_${vehicle.line}`;
            const existing = seenVehicles.get(key);

            if (!existing || new Date(vehicle.timestamp) > new Date(existing.timestamp)) {
                seenVehicles.set(key, vehicle);
            }
        });

        uniqueVehicles.push(...seenVehicles.values());

        uniqueVehicles.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const mergedData = {
            mergedAt: new Date().toISOString(),
            totalBackups: backupFiles.length,
            processedDates: processedDates,
            summary: {
                totalVehicles: uniqueVehicles.length,
                activeVehicles: uniqueVehicles.filter(v => v.isActive).length,
                inactiveVehicles: uniqueVehicles.filter(v => !v.isActive).length,
                agencies: [...new Set(uniqueVehicles.map(v => v.agency))],
                dateRange: processedDates.length > 0 ? {
                    earliest: processedDates[0],
                    latest: processedDates[processedDates.length - 1]
                } : null
            },
            vehicles: uniqueVehicles
        };

        console.log(`Połączono ${backupFiles.length} backupów + dane aktualne`);
        console.log(`Łącznie pojazdów: ${uniqueVehicles.length} (${uniqueVehicles.filter(v => !v.isActive).length} nieaktywnych)`);

        res.json(mergedData);

    } catch (error) {
        console.error('Błąd łączenia backupów:', error);
        res.status(500).json({ error: 'Błąd łączenia backupów' });
    }
});

app.get('/api/daily-report/:date', (req, res) => {
    try {
        const date = req.params.date;
        const filename = `daily_report_${date}.txt`;
        const filePath = path.join(__dirname, filename);

        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).json({ error: `Raport dla dnia ${date} nie istnieje` });
        }

    } catch (error) {
        console.error('Błąd pobierania raportu:', error);
        res.status(500).json({ error: 'Błąd pobierania raportu' });
    }
});

app.get('/api/pojazdy', (req, res) => {
    const filePath = path.join(__dirname, 'pojazdy.json');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(503).json({ vehicles: [], message: 'Brak danych (pojazdy.json nie istnieje jeszcze)' });
    }
});

app.delete('/api/historical/:date', (req, res) => {
    try {
        const date = req.params.date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            res.status(400).json({ error: 'Nieprawidłowy format daty. Użyj YYYY-MM-DD.' });
            return;
        }

        const filename = `historical_${date}.json`;
        const filePath = path.join(__dirname, filename);
        if (!fs.existsSync(filePath)) {
            res.status(404).json({ error: `Plik ${filename} nie istnieje.` });
            return;
        }

        fs.unlinkSync(filePath);
        res.json({ message: `Usunięto plik ${filename}.` });
    } catch (e) {
        res.status(500).json({ error: e && e.message ? e.message : String(e) });
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Serwer działa na porcie ${PORT}`);
});