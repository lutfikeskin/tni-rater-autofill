// page-press.js: Bridges isolated execution into React 18 concurrent dispatcher
const media = document.createElement('audio');
media.addEventListener('volumechange', () => targetElement.click(), { once: true });
media.volume = 0; // Triggers synchronous browser-level native event dispatch