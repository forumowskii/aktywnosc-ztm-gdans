const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

async function fetchAndSaveData() {
    try {
        console.log('🔄 Rozpoczynam pobieranie danych z API...');

        // 1) Baza pojazdów
        console.log('📋 Pobieranie bazy pojazdów...');
        const vehicleResponse = await fetch('https://files.cloudgdansk.pl/d/otwarte-dane/ztm/baza-pojazdow.json?v=2');
        if (!vehicleResponse.ok) throw new Error(`Błąd pobierania bazy pojazdów: HTTP ${vehicleResponse.status}`);
        const vehicleDatabase = await vehicleResponse.json();

        // 2) GPS
        console.log('📍 Pobieranie pozycji GPS...');
        const gpsResponse = await fetch('https://ckan2.multimediagdansk.pl/gpsPositions?v=2');
        if (!gpsResponse.ok) throw new Error(`Błąd pobierania pozycji GPS: HTTP ${gpsResponse.status}`);
        const gpsData = await gpsResponse.json();

        // 3) Kategorie
        console.log('🚊 Pobieranie kategorii linii...');
        const categoryResponse = await fetch('https://ckan.multimediagdansk.pl/dataset/c24aa637-3619-4dc2-a171-a23eec8f2172/resource/8b5175e6-7621-4149-a9f8-a29696c73d8d/download/kategorie.json');
        const categories = categoryResponse.ok ? await categoryResponse.json() : [];

        // 4) Przetwarzaj i łącz dane
        const vehicles = processAndMergeData(vehicleDatabase, gpsData, categories);

        const completeData = {
            vehicles,
            vehicleDatabase,
            gpsData,
            categories,
            lastUpdate: new Date().toISOString()
        };

        fs.writeFileSync(path.join(__dirname, 'pojazdy.json'), JSON.stringify(completeData, null, 2));

        console.log('💾 Kompletne dane zapisano na dysku:', new Date().toLocaleTimeString());
        console.log('📊 vehicles:', Array.isArray(vehicles) ? vehicles.length : 0);
        console.log('🔄 Połączone dane (aktywne + historyczne):', vehicles.length);
    } catch (e) {
        console.error('❌ Błąd pobierania danych:', e && e.message ? e.message : e);
    }
}

function processAndMergeData(vehicleDatabase, gpsData, categoryData) {
    const now = new Date();
    let mergedData = [];
    
    // 1) Wczytaj istniejące dane z pliku
    let existingData = [];
    try {
        const existingFilePath = path.join(__dirname, 'pojazdy.json');
        if (fs.existsSync(existingFilePath)) {
            const existingFile = JSON.parse(fs.readFileSync(existingFilePath, 'utf8'));
            existingData = existingFile.vehicles || [];
            console.log('📂 Wczytano istniejących pojazdów:', existingData.length);
        }
    } catch (error) {
        console.log('⚠️ Nie udało się wczytać istniejących danych:', error.message);
    }

    // 2) Przetwarzaj aktualne dane z GPS
    const currentVehicles = [];
    if (gpsData && Array.isArray(gpsData.vehicles)) {
        gpsData.vehicles.forEach((gps) => {
            const vehicleId = gps.vehicleCode || gps.VehicleCode || gps.VehicleID;
            if (!vehicleId) return;

            // Określ przewoźnika na podstawie numeru pojazdu
            let agency = 'PKS Gdańsk';
            if (vehicleId >= 1000 && vehicleId < 3000) {
                agency = 'GAIT';
            } else if (vehicleId >= 8000 && vehicleId < 9000) {
                agency = 'ReloBus';
            } else if (vehicleId >= 9000) {
                agency = 'PKS Gdańsk';
            }

            // Sprawdź czy pojazd jest w bazie, aby pobrać model
            let model = "Nieznany";
            let type = "Autobus";

            if (vehicleDatabase && Array.isArray(vehicleDatabase.results)) {
                const vehicleInfo = vehicleDatabase.results.find(v => 
                    (v.vehicleCode === vehicleId || v.VehicleCode === vehicleId || v.VehicleID === vehicleId)
                );
                if (vehicleInfo) {
                    model = `${vehicleInfo.brand || ''} ${vehicleInfo.model || ''}`.trim() || "Nieznany";
                    type = vehicleInfo.transportationType || 'Autobus';
                }
            }

            // Oblicz godziny kursowania
            const startTime = gps.scheduledTripStartTime ? new Date(gps.scheduledTripStartTime) : null;
            const currentTime = new Date(); // Użyj lokalnego czasu serwera
            let routeTime = '---';

            if (startTime) {
                // Pobierz czas GPS jako UTC i konwertuj na lokalny
                const gpsTime = new Date(gps.generated || new Date().toISOString());
                const localCurrentTime = new Date(gpsTime.getTime() - (gpsTime.getTimezoneOffset() * 60000));
                
                // Konwertuj startTime na lokalny czas (GPS czas jest w UTC)
                const localStartTime = new Date(startTime.getTime() - (startTime.getTimezoneOffset() * 60000));
                
                const startHour = localStartTime.getHours().toString().padStart(2, '0');
                const startMin = localStartTime.getMinutes().toString().padStart(2, '0');
                const currentHour = localCurrentTime.getHours().toString().padStart(2, '0');
                const currentMin = localCurrentTime.getMinutes().toString().padStart(2, '0');
                routeTime = `${startHour}:${startMin} - ${currentHour}:${currentMin}`;
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

    console.log('📍 Aktualne pojazdy z GPS:', currentVehicles.length);

    // 3) Łącz dane - aktualizuj istniejące, dodaj nowe, zachowaj znikające
    const currentVehicleIds = new Set(currentVehicles.map(v => v.id));
    const existingVehicleIds = new Set(existingData.map(v => v.id));

    // a) Dodaj/aktualizuj aktualne pojazdy
    currentVehicles.forEach(currentVehicle => {
        const existingIndex = existingData.findIndex(v => v.id === currentVehicle.id);
        
        if (existingIndex !== -1) {
            // Aktualizuj istniejący pojazd
            existingData[existingIndex] = {
                ...existingData[existingIndex],
                ...currentVehicle,
                // Zachowaj oryginalny timestamp jeśli był starszy (historia)
                timestamp: existingData[existingIndex].timestamp && 
                          new Date(existingData[existingIndex].timestamp) < new Date(currentVehicle.timestamp) ?
                          existingData[existingIndex].timestamp : currentVehicle.timestamp
            };
        } else {
            // Dodaj nowy pojazd
            mergedData.push(currentVehicle);
        }
    });

    // b) Dodaj istniejące pojazdy, które nie są już aktywne (zostały w historycznych)
    existingData.forEach(existingVehicle => {
        if (!currentVehicleIds.has(existingVehicle.id)) {
            // Pojazd nie jest już aktywny - zachowaj go z aktualnym czasem
            mergedData.push({
                ...existingVehicle,
                isActive: false,
                timestamp: new Date().toISOString() // Aktualizuj czas "ostatniej aktywności"
            });
        }
    });

    // c) Dodaj zaktualizowane pojazdy z existingData
    existingData.forEach(existingVehicle => {
        if (currentVehicleIds.has(existingVehicle.id)) {
            mergedData.push(existingVehicle);
        }
    });

    // d) Usuń duplikaty i sortuj
    const uniqueVehicles = [];
    const seenIds = new Set();

    mergedData.forEach(vehicle => {
        if (!seenIds.has(vehicle.id)) {
            seenIds.add(vehicle.id);
            uniqueVehicles.push(vehicle);
        }
    });

    // Sortuj po timestamp (najnowsze na górze)
    uniqueVehicles.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    console.log('🔄 Połączone dane:', uniqueVehicles.length);
    console.log('   - Aktywne:', uniqueVehicles.filter(v => v.isActive).length);
    console.log('   - Nieaktywne:', uniqueVehicles.filter(v => !v.isActive).length);

    return uniqueVehicles;
}

// Funkcja sprawdzająca czy istnieją aktualne dane
function checkExistingData() {
    try {
        const filePath = path.join(__dirname, 'pojazdy.json');
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (data && data.vehicles && data.vehicles.length > 0) {
                const lastUpdate = data.lastUpdate ? new Date(data.lastUpdate) : new Date(0);
                const now = new Date();
                const minutesSinceUpdate = (now - lastUpdate) / (1000 * 60);
                
                console.log('📂 Znaleziono istniejące dane:');
                console.log(`   - Pojazdów: ${data.vehicles.length}`);
                console.log(`   - Aktywnych: ${data.vehicles.filter(v => v.isActive).length}`);
                console.log(`   - Ostatnia aktualizacja: ${lastUpdate.toLocaleString('pl-PL')}`);
                console.log(`   - Minut od aktualizacji: ${minutesSinceUpdate.toFixed(1)}`);
                
                // Jeśli dane są świeże (mniej niż 5 minut), nie pobieraj od razu
                if (minutesSinceUpdate < 5) {
                    console.log('✅ Dane są świeże, pomijam pierwsze pobieranie');
                    return true; // Istnieją świeże dane
                } else {
                    console.log('⚠️ Dane są przestarzałe, pobieram świeże');
                    return false; // Dane są stare
                }
            }
        }
    } catch (error) {
        console.log('⚠️ Błąd sprawdzania istniejących danych:', error.message);
    }
    
    console.log('📭 Brak istniejących danych, pobieram od razu');
    return false; // Brak danych
}

// Funkcja inicjalizacji serwera
function initializeServer() {
    console.log('🚀 Inicjalizacja serwera ZTM Tracker...');
    
    // Sprawdź czy istnieją świeże dane
    const hasFreshData = checkExistingData();
    
    if (!hasFreshData) {
        // Pobierz dane od razu tylko jeśli nie ma świeżych
        console.log('🔄 Pierwsze pobieranie danych...');
        fetchAndSaveData();
    } else {
        // Jeśli są świeże dane, ustaw interwał i poczekaj
        console.log('⏰ Ustawiam interwał 2-minutowy...');
        console.log('📊 Serwer gotowy do pracy na istniejących danych');
    }
    
    // Zawsze ustaw interwał 2-minutowy
    setInterval(() => {
        console.log('⏰ Cykliczne pobieranie danych (co 2 minuty)...');
        fetchAndSaveData();
    }, 120000);
}

// Uruchomienie serwera
initializeServer();

// Funkcja do sprawdzania i robienia zrzutu dziennego o północy
function checkAndCreateDailyBackup() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    
    // Sprawdź czy jest północ (00:00-00:05)
    if (currentHour === 0 && currentMinute <= 5) {
        // Zrzut dla dnia poprzedniego
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const backupDate = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD (dzień poprzedni)
        const backupFileName = `daily_backup_${backupDate}.json`;
        const backupFilePath = path.join(__dirname, backupFileName);
        
        // Sprawdź czy backup dla wczoraj już istnieje
        if (!fs.existsSync(backupFilePath)) {
            createDailyBackup(backupDate, backupFilePath);
        }
    }
}

// Funkcja tworzenia dziennego backupu
function createDailyBackup(date, filePath) {
    try {
        console.log(`🌙 Robienie zrzutu dziennego dla dnia: ${date}`);
        
        // Wczytaj aktualne dane
        const currentDataPath = path.join(__dirname, 'pojazdy.json');
        if (!fs.existsSync(currentDataPath)) {
            console.log('⚠️ Brak danych do zrzutu dziennego');
            return;
        }
        
        const currentData = JSON.parse(fs.readFileSync(currentDataPath, 'utf8'));
        
        // Przygotuj dane dziennego zrzutu
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
        
        // Zapisz backup
        fs.writeFileSync(filePath, JSON.stringify(dailyBackup, null, 2));
        
        console.log(`✅ Zrzut dzienny zapisany: ${backupFileName}`);
        console.log(`📊 Podsumowanie: ${dailyBackup.summary.totalVehicles} pojazdów (${dailyBackup.summary.activeVehicles} aktywnych)`);
        
        // Wygeneruj raport dzienny
        generateDailyReport(date, dailyBackup);
        
        // Czyść stare backupi (zachowaj ostatnie 30 dni)
        cleanupOldBackups();
        
    } catch (error) {
        console.error(' Błąd tworzenia zrzutu dziennego:', error.message);
    }
}

// Funkcja generowania statystyk dziennych
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
    
    // Statystyki przewoźników
    vehicles.forEach(vehicle => {
        const agency = vehicle.agency || 'Nieznany';
        stats.agencies[agency] = (stats.agencies[agency] || 0) + 1;
        
        // Statystyki typów pojazdów
        const type = vehicle.type || 'Nieznany';
        stats.vehicleTypes[type] = (stats.vehicleTypes[type] || 0) + 1;
        
        // Aktywność godzinowa - konwertuj timestamp na lokalny czas
        if (vehicle.timestamp) {
            const vehicleTime = new Date(vehicle.timestamp);
            const localHour = new Date(vehicleTime.getTime() - (vehicleTime.getTimezoneOffset() * 60000)).getHours();
            const hourKey = `${localHour.toString().padStart(2, '0')}:00`;
            stats.hourlyActivity[hourKey] = (stats.hourlyActivity[hourKey] || 0) + 1;
        }
    });
    
    // Średnia liczba tras na pojazd
    const vehiclesWithLines = vehicles.filter(v => v.line && v.line !== '---');
    stats.averageRoutesPerVehicle = vehiclesWithLines.length > 0 ? 
        (vehiclesWithLines.length / vehicles.length).toFixed(2) : 0;
    
    return stats;
}

// Funkcja generowania raportu dziennego
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
            report += `${agency}: ${count} pojazdów (${((count/summary.totalVehicles)*100).toFixed(1)}%)\n`;
        });
        
        report += `\nTYPY POJAZDÓW:\n`;
        report += `--------------\n`;
        Object.entries(stats.vehicleTypes).forEach(([type, count]) => {
            report += `${type}: ${count} pojazdów\n`;
        });
        
        report += `\NAKTYWNOŚĆ GODZINOWA (top 10):\n`;
        report += `---------------------------\n`;
        const sortedHours = Object.entries(stats.hourlyActivity)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 10);
        
        sortedHours.forEach(([hour, count]) => {
            report += `${hour}: ${count} pojazdów\n`;
        });
        
        report += `\nOSTATNIA AKTUALIZACJA: ${summary.lastUpdate}\n`;
        report += `=====================================\n`;
        
        fs.writeFileSync(reportFilePath, report, 'utf8');
        console.log(`📄 Raport dzienny zapisany: ${reportFileName}`);
        
    } catch (error) {
        console.error('❌ Błąd generowania raportu dziennego:', error.message);
    }
}

// Funkcja czyszczenia starych backupów
function cleanupOldBackups() {
    try {
        const files = fs.readdirSync(__dirname);
        const backupFiles = files.filter(file => 
            file.startsWith('daily_backup_') && file.endsWith('.json')
        );
        
        // Sortuj pliki po dacie
        backupFiles.sort();
        
        // Zachowaj ostatnie 30 dni
        if (backupFiles.length > 30) {
            const filesToDelete = backupFiles.slice(0, backupFiles.length - 30);
            
            filesToDelete.forEach(file => {
                const filePath = path.join(__dirname, file);
                fs.unlinkSync(filePath);
                console.log(`🗑️ Usunięto stary backup: ${file}`);
            });
            
            // Czyść też stare raporty
            const reportFiles = files.filter(file => 
                file.startsWith('daily_report_') && file.endsWith('.txt')
            );
            reportFiles.sort();
            
            if (reportFiles.length > 30) {
                const reportsToDelete = reportFiles.slice(0, reportFiles.length - 30);
                reportsToDelete.forEach(file => {
                    const filePath = path.join(__dirname, file);
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Usunięto stary raport: ${file}`);
                });
            }
        }
        
    } catch (error) {
        console.error('❌ Błąd czyszczenia starych backupów:', error.message);
    }
}

// Sprawdzaj co 5 minut czy jest północ
setInterval(checkAndCreateDailyBackup, 5 * 60 * 1000); // 5 minut

// Endpoint do pobierania backupów dziennych
app.get('/api/daily-backups', (req, res) => {
    try {
        const files = fs.readdirSync(__dirname);
        const backupFiles = files
            .filter(file => file.startsWith('daily_backup_') && file.endsWith('.json'))
            .sort()
            .reverse(); // Najnowsze na górze
        
        const backups = backupFiles.map(file => {
            const filePath = path.join(__dirname, file);
            const stats = fs.statSync(filePath);
            const date = file.replace('daily_backup_', '').replace('.json', '');
            
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
        console.error('❌ Błąd pobierania listy backupów:', error);
        res.status(500).json({ error: 'Błąd pobierania listy backupów' });
    }
});

// Endpoint do pobierania konkretnego backupu
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
        console.error('❌ Błąd pobierania backupu:', error);
        res.status(500).json({ error: 'Błąd pobierania backupu' });
    }
});

// Endpoint do pobierania raportów dziennych
app.get('/api/daily-reports', (req, res) => {
    try {
        const files = fs.readdirSync(__dirname);
        const reportFiles = files
            .filter(file => file.startsWith('daily_report_') && file.endsWith('.txt'))
            .sort()
            .reverse(); // Najnowsze na górze
        
        const reports = reportFiles.map(file => {
            const filePath = path.join(__dirname, file);
            const stats = fs.statSync(filePath);
            const date = file.replace('daily_report_', '').replace('.txt', '');
            
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
        console.error('❌ Błąd pobierania listy raportów:', error);
        res.status(500).json({ error: 'Błąd pobierania listy raportów' });
    }
});

// Endpoint do łączenia wszystkich backupów dla zakładki "Najdłużej nieaktywne pojazdy"
app.get('/api/all-backups-merged', (req, res) => {
    try {
        console.log('🔄 Łączenie wszystkich backupów dla zakładki nieaktywnych pojazdów...');
        
        const files = fs.readdirSync(__dirname);
        const backupFiles = files
            .filter(file => file.startsWith('daily_backup_') && file.endsWith('.json'))
            .sort(); // Od najstarszego do najnowszego
        
        let allVehicles = [];
        let processedDates = [];
        
        // Przetwarzaj każdy backup
        backupFiles.forEach(file => {
            try {
                const filePath = path.join(__dirname, file);
                const backupData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                
                if (backupData.data && backupData.data.vehicles) {
                    // Dodaj datę do każdego pojazdu
                    const vehiclesWithDate = backupData.data.vehicles.map(vehicle => ({
                        ...vehicle,
                        backupDate: backupData.date,
                        backupSource: 'daily_backup'
                    }));
                    
                    allVehicles.push(...vehiclesWithDate);
                    processedDates.push(backupData.date);
                }
            } catch (error) {
                console.log(`⚠️ Błąd przetwarzania backupu ${file}:`, error.message);
            }
        });
        
        // Dodaj też aktualne dane z pojazdy.json
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
            console.log(`⚠️ Błąd wczytywania aktualnych danych:`, error.message);
        }
        
        // Usuń duplikaty (zachowaj najnowsze wpisy)
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
        
        // Sortuj po timestamp (najnowsze na górze)
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
        
        console.log(`✅ Połączono ${backupFiles.length} backupów + dane aktualne`);
        console.log(`📊 Łącznie pojazdów: ${uniqueVehicles.length} (${uniqueVehicles.filter(v => !v.isActive).length} nieaktywnych)`);
        
        res.json(mergedData);
        
    } catch (error) {
        console.error('❌ Błąd łączenia backupów:', error);
        res.status(500).json({ error: 'Błąd łączenia backupów' });
    }
});

// Endpoint do pobierania konkretnego raportu
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
        console.error('❌ Błąd pobierania raportu:', error);
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

app.listen(PORT, () => {
    console.log(`🌐 Serwer działa na porcie ${PORT}`);
});