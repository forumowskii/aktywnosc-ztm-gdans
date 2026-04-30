// Service Worker dla PWA - ZTM Tracker
const CACHE_NAME = 'ztm-tracker-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://files.cloudgdansk.pl/d/otwarte-dane/ztm/baza-pojazdow.json?v=2',
  'https://ckan2.multimediagdansk.pl/gpsPositions?v=2',
  'https://ckan.multimediagdansk.pl/dataset/c24aa637-3619-4dc2-a171-a23eec8f2172/resource/8b5175e6-7621-4149-a9f8-a29696c73d8d/download/kategorie.json'
];

// Instalacja Service Workera
self.addEventListener('install', event => {
  console.log('🔧 Service Worker instaluje się...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('📦 Cache otwarte, zapisuję pliki');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log('✅ Service Worker zainstalowany pomyślnie');
        return self.skipWaiting();
      })
  );
});

// Aktywacja Service Workera
self.addEventListener('activate', event => {
  console.log('🚀 Service Worker aktywowany');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('🗑️ Usuwam stary cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('✅ Service Worker aktywny');
      return self.clients.claim();
    })
  );
});

// Obsługa żądań (fetch)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // Obsługa żądań API - zawsze z sieci (świeże dane)
  if (url.hostname.includes('cloudgdansk.pl') || 
      url.hostname.includes('multimediagdansk.pl')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Klonuj odpowiedź i zapisz w cache
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(() => {
          // Jeśli sieć nie działa, spróbuj z cache
          return caches.match(event.request);
        })
    );
    return;
  }
  
  // Obsługa żądań lokalnych - najpierw cache, potem sieć
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit - return response
        if (response) {
          return response;
        }
        
        // Nie ma w cache - pobierz z sieci
        return fetch(event.request).then(response => {
          // Sprawdź czy odpowiedź jest prawidłowa
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          
          // Klonuj odpowiedź i zapisz w cache
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
          
          return response;
        });
      })
  );
});

// Push notifications (opcjonalnie)
self.addEventListener('push', event => {
  console.log('📱 Push message otrzymany:', event);
  
  const options = {
    body: event.data ? event.data.text() : 'Nowe dane pojazdów dostępne',
    icon: '/icon-192x192.png',
    badge: '/icon-72x72.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'explore',
        title: 'Otwórz aplikację',
        icon: '/icon-96x96.png'
      }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification('ZTM Tracker', options)
  );
});

// Obsługa kliknięcia w powiadomienie
self.addEventListener('notificationclick', event => {
  console.log('🔔 Kliknięto w powiadomienie:', event.notification);
  
  event.notification.close();
  
  if (event.action === 'explore') {
    event.waitUntil(
      clients.openWindow('/')
    );
  }
});
