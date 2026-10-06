import { App } from './app';
import './styles/main.css';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');

const app = new App(root);
void app.start();

// Debug/test hook (used by end-to-end tests); harmless in production.
(window as unknown as { art?: App }).art = app;

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        // When a new version has been installed, offer to reload.
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              app.toast('A new version of Art is ready — it will be used next time you open the app.');
            }
          });
        });
      })
      .catch((err) => console.warn('Service worker registration failed', err));
  });
}
