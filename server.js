const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Funkcja pobierająca i zapisująca WSZYSTKIE dane co 2 minuty
setInterval(async () => {
    try {
        console.log('🔄 Rozpoczynam pobieranie danych z API...');
        
        // Pobieranie bazy pojazdów
        console.log('📋 Pobieranie bazy pojazdów...');
        const vehicleResponse = await fetch('https://files.cloudgdansk.pl/d/otwarte-dane/ztm/baza-pojazdow.json?v=2');
        if (!vehicleResponse.ok) throw new Error('Błąd pobierania bazy pojazdów');
        const vehicleData = await vehicleResponse.json();
        console.log('✅ Pobrano pojazdów:', vehicleData?.count || 0);
        
        // Pobieranie pozycji GPS
        console.log('📍 Pobieranie pozycji GPS...');
        const gpsResponse = await fetch('https://ckan2.multimediagdansk.pl/gpsPositions?v=2');
        if (!gpsResponse.ok) throw new Error('Błąd pobierania pozycji GPS');
        const gpsData = await gpsResponse.json();
        console.log('✅ Pobrano pozycji GPS:', gpsData?.vehicles?.length || 0);
        
        // Pobieranie kategorii linii
        console.log('🚊 Pobieranie kategorii linii...');
        const categoryResponse = await fetch('https://ckan.multimediagdansk.pl/dataset/c24aa637-3619-4dc2-a171-a23eec8f2172/resource/8b5175e6-7621-4149-a9f8-a29696c73d8d/download/kategorie.json');
        let categoryData = [];
        if (categoryResponse.ok) {
            categoryData = await categoryResponse.json();
            console.log('✅ Pobrano kategorii:', categoryData?.length || 0);
        } else {
            console.log('⚠️ Kategoria linii niedostępna');
        }
        
        // Przetwarzanie danych - łączenie wszystkich informacji
        const processedData = processAllData(vehicleData, gpsData, categoryData);
        
        // Zapis kompletnych danych na dysk
        const completeData = {
            timestamp: new Date().toISOString(),
            vehicles: processedData,
            vehicleDatabase: vehicleData,
            gpsData: gpsData,
            categories: categoryData,
            lastUpdate: new Date().toLocaleString('pl-PL')
        };
        
        fs.writeFileSync(path.join(__dirname, 'pojazdy.json'), JSON.stringify(completeData, null, 2));
        console.log('💾 Kompletne dane zapisano na dysku:', new Date().toLocaleTimeString());
        console.log('📊 Zapisano pojazdów:', processedData.length);
        
    } catch (error) {
        console.error('❌ Błąd pobierania danych:', error.message);
    }
}, 120000); // 120,000 ms = 2 minuty

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
        res.json({ timestamp: new Date().toISOString(), vehicles: [], message: 'Brak danych' });
    }
});

// Endpoint dla zapisywania danych z HTML-a
app.post('/api/save-vehicle', (req, res) => {
    try {
        const vehicleData = req.body;
        const filePath = path.join(__dirname, 'pojazdy.json');
        
        let existingData = { vehicles: [] };
        if (fs.existsSync(filePath)) {
            existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        
        // Dodaj nowy pojazd
        if (!existingData.vehicles) {
            existingData.vehicles = [];
        }
        
        existingData.vehicles.push({
            ...vehicleData,
            timestamp: new Date().toISOString(),
            source: 'manual'
        });
        
        fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2));
        
        console.log('✅ Zapisano pojazd z HTML-a:', vehicleData.id);
        res.json({ success: true, message: 'Pojazd zapisany' });
    } catch (error) {
        console.error('❌ Błąd zapisu pojazdu:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint dla pobierania danych historycznych
app.get('/api/historical/:date', (req, res) => {
    const date = req.params.date;
    const filePath = path.join(__dirname, `historical_${date}.json`);
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.json({ date: date, vehicles: [], message: 'Brak danych historycznych' });
    }
});

// Endpoint dla zapisywania danych historycznych
app.post('/api/historical/:date', (req, res) => {
    try {
        const date = req.params.date;
        const data = req.body;
        const filePath = path.join(__dirname, `historical_${date}.json`);
        
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        
        console.log(`✅ Zapisano dane historyczne dla dnia ${date}:`, data.vehicles?.length || 0);
        res.json({ success: true, message: `Dane historyczne zapisane dla dnia ${date}` });
    } catch (error) {
        console.error('❌ Błąd zapisu danych historycznych:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Uruchomienie pierwszego pobrania danych
console.log('🚀 Uruchamiam serwer i pierwsze pobieranie danych...');
fetchAndSaveData();

app.listen(PORT, () => {
    console.log(`🌐 Serwer działa na http://localhost:${PORT}`);
    console.log('📊 API endpoints:');
    console.log('   GET  /api/pojazdy - pobierz pojazdy');
    console.log('   POST /api/save-vehicle - zapisz pojazd');
    console.log('   GET  /api/historical/:date - pobierz dane historyczne');
    console.log('   POST /api/historical/:date - zapisz dane historyczne');
});

// Funkcja do pierwszego pobrania
async function fetchAndSaveData() {
    try {
        console.log('🔄 Pierwsze pobieranie danych...');
        
        const vehicleResponse = await fetch('https://files.cloudgdansk.pl/d/otwarte-dane/ztm/baza-pojazdow.json?v=2');
        const vehicleData = await vehicleResponse.json();
        
        const gpsResponse = await fetch('https://ckan2.multimediagdansk.pl/gpsPositions?v=2');
        const gpsData = await gpsResponse.json();
        
        const categoryResponse = await fetch('https://ckan.multimediagdansk.pl/dataset/c24aa637-3619-4dc2-a171-a23eec8f2172/resource/8b5175e6-7621-4149-a9f8-a29696c73d8d/download/kategorie.json');
        const categoryData = categoryResponse.ok ? await categoryResponse.json() : [];
        
        const processedData = processAllData(vehicleData, gpsData, categoryData);
        
        const completeData = {
            timestamp: new Date().toISOString(),
            vehicles: processedData,
            vehicleDatabase: vehicleData,
            gpsData: gpsData,
            categories: categoryData,
            lastUpdate: new Date().toLocaleString('pl-PL')
        };
        
        fs.writeFileSync(path.join(__dirname, 'pojazdy.json'), JSON.stringify(completeData, null, 2));
        console.log('✅ Pierwsze dane zapisano pomyślnie');
        
    } catch (error) {
        console.error('❌ Błąd pierwszego pobierania:', error.message);
    }
}