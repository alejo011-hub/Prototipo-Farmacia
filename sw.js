const CACHE_NAME = 'ermita-pwa-v2'; // Subimos la versión para forzar el cambio
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './chatbot.js',
  './productos.json',
  './guia-productos.json',
  './manifest.json'
];

// Instala el service worker y guarda los archivos
self.addEventListener('install', (event) => {
  self.skipWaiting(); // Fuerza a que esta nueva versión se instale de inmediato
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

// Limpia el caché viejo cada vez que actualizas tu código
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('Borrando caché antiguo:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Estrategia "Red primero": siempre intenta traer lo más nuevo de GitHub. 
// Si no hay internet, muestra la versión guardada en caché.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Actualiza el caché silenciosamente con la versión más nueva
        return caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, networkResponse.clone());
          return networkResponse;
        });
      })
      .catch(() => {
        // Si falla (no hay internet), usa el caché
        return caches.match(event.request);
      })
  );
});
