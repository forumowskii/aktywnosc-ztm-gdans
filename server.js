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

        const vehicles = processAllData(vehicleDatabase, gpsData, categories);

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
    } catch (e) {
        console.error('❌ Błąd pobierania danych:', e && e.message ? e.message : e);
    }
}

// Pierwsze pobranie od razu + cyklicznie co 2 minuty
fetchAndSaveData();
setInterval(fetchAndSaveData, 120000);

// Funkcja przetwarzająca wszystkie dane
function processAllData(vehicleData, gpsData, categoryData) {
    const processed = [];
    const now = new Date();

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

            if (vehicleData && Array.isArray(vehicleData.results)) {
                const vehicleInfo = vehicleData.results.find(v => 
                    (v.vehicleCode === vehicleId || v.VehicleCode === vehicleId || v.VehicleID === vehicleId)
                );
                if (vehicleInfo) {
                    model = `${vehicleInfo.brand || ''} ${vehicleInfo.model || ''}`.trim() || "Nieznany";
                    type = vehicleInfo.transportationType || 'Autobus';
                }
            }

            // Oblicz godziny kursowania
            const startTime = gps.scheduledTripStartTime ? new Date(gps.scheduledTripStartTime) : null;
            const currentTime = new Date(gps.generated || now);
            let routeTime = '---';

            if (startTime) {
                const startHour = startTime.getHours().toString().padStart(2, '0');
                const startMin = startTime.getMinutes().toString().padStart(2, '0');
                const currentHour = currentTime.getHours().toString().padStart(2, '0');
                const currentMin = currentTime.getMinutes().toString().padStart(2, '0');
                routeTime = `${startHour}:${startMin} - ${currentHour}:${currentMin}`;
            }

            processed.push({
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

    return processed;
}

// Endpoint dla pobierania pojazdów
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