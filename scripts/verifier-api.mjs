
import { ouvrirSession } from './session.mjs';
// Le serveur exige un compte depuis le chantier d'authentification.
const { jeton } = await ouvrirSession();
const B = 'http://localhost:3001';
const j = async (u, o) => { const r = await fetch(B+u, o); return [r.status, await r.json().catch(()=>null)]; };
const post = (u, b) => j(u, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(b)});
const ok = (c, m) => console.log(`${c ? ' PASS' : ' ECHEC'}  ${m}`);

// --- 1. temps reel : le WS pousse-t-il les etats ?
const { WebSocket } = globalThis; // WebSocket natif de Node 22
let pushes = 0, sawSnapshot = false;
const ws = new WebSocket('ws://localhost:3001/ws', { headers: { authorization: `Bearer ${jeton}` } });
await new Promise(r => { ws.onopen = r; ws.onerror = r; });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type==='snapshot') sawSnapshot = true; if (m.type==='state') pushes++; };
await new Promise(r => setTimeout(r, 1500));
ok(sawSnapshot, 'WebSocket : instantane recu a la connexion');

// --- 2. action groupee (bouton "Tout eteindre")
const [, cfg] = await j('/api/config');
const lights = cfg.devices.filter(d => d.type==='light'||d.type==='dimmer').map(d=>d.id);
await post('/api/commands/bulk', { deviceIds: lights, command:{kind:'switch',state:true} });
await new Promise(r => setTimeout(r, 900));
let [, st] = await j('/api/state');
const onCount = st.states.filter(s => s.caps.some(c=>c.kind==='switch'&&c.state)).length;
ok(onCount === lights.length, `Action groupee : ${onCount}/${lights.length} eclairages allumes`);

await post('/api/commands/bulk', { deviceIds: lights, command:{kind:'switch',state:false} });
await new Promise(r => setTimeout(r, 900));
[, st] = await j('/api/state');
ok(st.states.filter(s=>s.caps.some(c=>c.kind==='switch'&&c.state)).length === 0, 'Tout eteindre : plus aucun eclairage');
ok(pushes > 20, `Temps reel : ${pushes} etats pousses pendant le test`);

// --- 3. la validation refuse-t-elle une config cassee ?
const bad = structuredClone(cfg);
bad.devices[0].zoneId = 'zone-fantome';
const [code, body] = await j('/api/config', {method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify(bad)});
ok(code === 400 && body.issues?.length, `Validation : zone inexistante refusee (${body.issues?.[0]?.message ?? ''})`);

// --- 4. parametrage : ajouter une zone + un equipement, sans toucher au code
// On nettoie d'abord : un run interrompu laisse z99 en base et la creation
// echouerait sur un doublon d'identifiant.
await j('/api/config/zones/z99', { method: 'DELETE' });
await new Promise(r => setTimeout(r, 400));
const zone = { id:'z99', label:'Atelier', kind:'utility', order:99, heated:false };
const [zc] = await post('/api/config/zones', zone);
const dev = { id:'z99.light.etabli', zoneId:'z99', label:'Etabli', type:'light', order:0, staleAfterSeconds:300, binding:null, sim:{} };
const [dc] = await post('/api/config/devices', dev);
await new Promise(r => setTimeout(r, 800));
[, st] = await j('/api/state');
const born = st.states.find(s => s.id === 'z99.light.etabli');
ok(zc===200 && dc===200 && !!born, 'Parametrage : zone + equipement crees et vivants immediatement');

// --- 5. le nouvel equipement obeit-il ?
await post('/api/devices/z99.light.etabli/command', {kind:'switch',state:true});
await new Promise(r => setTimeout(r, 500));
[, st] = await j('/api/state');
ok(st.states.find(s=>s.id==='z99.light.etabli')?.caps[0]?.state === true, 'Le nouvel equipement repond aux commandes');

// --- 6. un canal injoignable ne doit pas emporter le reste
const avecPanne = {
  ...cfg,
  connections: [
    { id: 'sim', kind: 'sim', label: 'Simulateur', enabled: true, settings: {} },
    { id: 'mort', kind: 'mqtt', label: 'Broker injoignable', enabled: true,
      settings: { url: 'mqtt://127.0.0.1:1', username: '', password: '', baseTopic: 'x' } },
  ],
};
const [sc] = await j('/api/config', {method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify(avecPanne)});
await new Promise(r => setTimeout(r, 1500));
const [, cx] = await j('/api/connections');
const mort = cx.connections.find(c => c.id === 'mort');
const vivant = cx.connections.find(c => c.id === 'sim');
ok(sc===200 && mort?.state === 'error' && vivant?.state === 'connected',
   `Canal injoignable isole : "${mort?.detail}" : le simulateur continue`);

const [cmdCode] = await post('/api/devices/z01.light.plafond/command', {kind:'switch',state:true});
ok(cmdCode === 200, 'Les equipements simules repondent malgre le canal en panne');

// retour a une configuration saine + menage
await j('/api/config', {method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify(cfg)});
await j('/api/config/zones/z99', {method:'DELETE'});
await new Promise(r => setTimeout(r, 600));
const [, final] = await j('/api/config');
ok(!final.zones.some(z=>z.id==='z99') && !final.devices.some(d=>d.zoneId==='z99'),
   'Suppression de zone : equipements orphelins nettoyes');
ws.close();
