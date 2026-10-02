import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Phones that saved the portal to the home screen keep the old page in memory and
// have no refresh button, so fixes never reached them. Whenever the page comes back
// on screen, check whether a newer build is deployed and reload into it. Unsaved
// sets are safe: the logger keeps pending sets on the phone and restores them on open.
const myBuild = [...document.scripts].map((s) => s.src).find((s) => /\/assets\/index-[^/]+\.js/.test(s));
async function checkForNewBuild() {
  if (!myBuild) return; // dev server: no hashed bundle
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const m = html.match(/\/assets\/index-[^"']+\.js/);
    if (m && !myBuild.endsWith(m[0])) window.location.reload();
  } catch (e) { /* offline: try again next time */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForNewBuild(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) checkForNewBuild(); });
