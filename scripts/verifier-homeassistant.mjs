/**
 * L'adaptateur Home Assistant, mis a l'epreuve contre un FAUX Home Assistant.
 *
 * On monte un serveur WebSocket qui se comporte comme le vrai : il exige la
 * poignee de main, sert un instantane, diffuse des changements d'etat, et
 * accuse reception des appels de service. L'adaptateur est instancie
 * directement contre lui, sans passer par le serveur de la maison : on teste
 * la traduction, pas la plomberie qui l'entoure.
 *
 * Ce qui est verifie ici et nulle part ailleurs :
 *   . un jeton refuse donne un message qu'on peut corriger ;
 *   . les domaines de Home Assistant tombent dans les bonnes capacites ;
 *   . la luminosite fait l'aller-retour SANS deriver (0-255 contre 0-100) ;
 *   . une commande part en appel de service, et l'etat n'est PAS invente :
 *     il attend l'evenement que Home Assistant renverra ;
 *   . une entite que personne ne reclame devient un candidat a l'adoption ;
 *   . une connexion perdue se reprend toute seule.
 */
import { WebSocketServer } from 'ws';
import { HomeAssistantAdapter } from '../packages/server/dist/adapters/homeassistant.js';

const PORT = 18880;
const ok = (c, m) => { console.log(`${c ? ' PASS ' : ' ECHEC'}  ${m}`); if (!c) process.exitCode = 1; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================================================== le faux Home Assistant

/** Les entites servies par l'instantane. */
const ENTITES = [
  { entity_id: 'light.salon', state: 'on', attributes: { brightness: 102, friendly_name: 'Salon' } },
  { entity_id: 'cover.veranda', state: 'open', attributes: { current_position: 40 } },
  { entity_id: 'sensor.ext', state: '11.4', attributes: { unit_of_measurement: '°C' } },
  { entity_id: 'binary_sensor.porte', state: 'on', attributes: { device_class: 'door' } },
  {
    entity_id: 'climate.pac',
    state: 'heat',
    attributes: { current_temperature: 19.2, temperature: 21, hvac_action: 'heating' },
  },
  {
    entity_id: 'weather.forecast_maison',
    state: 'cloudy',
    attributes: { temperature: 17.5, humidity: 87, pressure: 1019.5 },
  },
  // Celle-ci n'est reclamee par personne : elle doit devenir un candidat.
  { entity_id: 'light.grenier', state: 'off', attributes: { friendly_name: 'Grenier' } },
];

let serveur = null;
let socketCourant = null;
const servicesAppeles = [];
const JETON = 'bon-jeton';

function demarrerFauxHA() {
  serveur = new WebSocketServer({ port: PORT });
  serveur.on('connection', (socket) => {
    socketCourant = socket;
    let authentifie = false;
    socket.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.10.0' }));

    socket.on('message', (brut) => {
      const m = JSON.parse(String(brut));

      if (m.type === 'auth') {
        if (m.access_token !== JETON) {
          socket.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token' }));
          socket.close();
          return;
        }
        authentifie = true;
        socket.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.10.0' }));
        return;
      }
      if (!authentifie) return;

      if (m.type === 'get_states') {
        socket.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: ENTITES }));
        return;
      }
      if (m.type === 'subscribe_events') {
        socket.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: null }));
        return;
      }
      if (m.type === 'call_service') {
        servicesAppeles.push({
          domain: m.domain,
          service: m.service,
          entity: m.target?.entity_id,
          data: m.service_data ?? {},
        });
        socket.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: {} }));
      }
    });
  });
  return new Promise((r) => serveur.on('listening', r));
}

/** Pousse un changement d'etat, comme le vrai le ferait. */
function diffuser(entity_id, state, attributes = {}) {
  socketCourant?.send(
    JSON.stringify({
      type: 'event',
      event: { data: { entity_id, new_state: { entity_id, state, attributes } } },
    }),
  );
}

// ====================================================== les faux equipements

const lien = (source) => ({
  connectionId: 'ha',
  reads: [{ source, path: '', into: 'switch.state', pipeline: [] }],
  writes: [],
});

const DEVICES = [
  { id: 'z03.light.general', zoneId: 'z03', label: 'Général', type: 'dimmer', order: 0, staleAfterSeconds: 90, binding: lien('light.salon') },
  { id: 'z03.cover.veranda', zoneId: 'z03', label: 'Véranda', type: 'cover', order: 1, staleAfterSeconds: 90, binding: lien('cover.veranda') },
  { id: 'z21.sensor.temp', zoneId: 'z21', label: 'Extérieur', type: 'sensor', metric: 'temperature', order: 2, staleAfterSeconds: 300, binding: lien('sensor.ext') },
  { id: 'z04.sensor.porte', zoneId: 'z04', label: "Porte d'entrée", type: 'sensor', metric: 'contact', order: 3, staleAfterSeconds: 300, binding: lien('binary_sensor.porte') },
  { id: 'z21.sensor.meteo', zoneId: 'z21', label: 'Température extérieure', type: 'sensor', metric: 'temperature', order: 5, staleAfterSeconds: 900, binding: lien('weather.forecast_maison') },
  { id: 'z21.sensor.humidite', zoneId: 'z21', label: 'Humidité', type: 'sensor', metric: 'humidity', order: 6, staleAfterSeconds: 900, binding: lien('weather.forecast_maison') },
  { id: 'z00.climate.pac', zoneId: 'z00', label: 'Chauffage', type: 'thermostat', order: 4, staleAfterSeconds: 300, binding: lien('climate.pac') },
];

/** Ce que l'adaptateur a emis, par equipement. */
const recus = new Map();

function fabriquer(settings) {
  return new HomeAssistantAdapter({
    connection: { id: 'ha', kind: 'homeassistant', label: 'Home Assistant', enabled: true, settings },
    emit: (patch) => recus.set(patch.deviceId, patch.caps),
    warn: () => {},
  });
}

const cap = (deviceId, kind) => (recus.get(deviceId) ?? []).find((c) => c.kind === kind);

// =============================================================== le scenario

await demarrerFauxHA();

// --- 1. le jeton refuse -----------------------------------------------------
{
  const a = fabriquer({ url: `http://127.0.0.1:${PORT}`, token: 'mauvais-jeton' });
  let message = null;
  try { await a.start(); } catch (e) { message = e.message; }
  ok(/[Jj]eton refusé/.test(message ?? ''), `Jeton refusé, message utile : « ${message} »`);
  await a.stop();
}

// --- 2. l'adresse manquante -------------------------------------------------
{
  const a = fabriquer({ url: '', token: JETON });
  let message = null;
  try { await a.start(); } catch (e) { message = e.message; }
  ok(/adresse/i.test(message ?? ''), `Adresse absente signalée : « ${message} »`);
  await a.stop();
}

// --- 3. la connexion, et l'instantane ---------------------------------------
const adaptateur = fabriquer({ url: `http://127.0.0.1:${PORT}`, token: JETON });
await adaptateur.attach(DEVICES);
await adaptateur.start();
await pause(250);

ok(adaptateur.status().state === 'connected', `Canal connecté : ${adaptateur.status().state}`);

{
  const sw = cap('z03.light.general', 'switch');
  const dim = cap('z03.light.general', 'dim');
  ok(sw?.state === true, `Lumière allumée : ${sw?.state}`);
  // 102 / 255 = 40 % exactement. C'est le piege : sans arrondi choisi, un
  // aller-retour fait reculer le curseur d'un point a chaque reglage.
  ok(dim?.level === 40, `Luminosité 102/255 traduite en ${dim?.level} %`);
}

{
  const c = cap('z03.cover.veranda', 'cover');
  ok(c?.position === 40, `Volet à ${c?.position} %`);
  ok(c?.moving === null, `Volet à l'arrêt : ${c?.moving}`);
}

ok(cap('z21.sensor.temp', 'sensor')?.value === 11.4, `Capteur : ${cap('z21.sensor.temp', 'sensor')?.value} °C`);
ok(cap('z04.sensor.porte', 'sensor')?.value === 1, `Contact ouvert vaut ${cap('z04.sensor.porte', 'sensor')?.value}`);

{
  const cl = cap('z00.climate.pac', 'climate');
  ok(cl?.ambient === 19.2, `Température ambiante : ${cl?.ambient} °C`);
  ok(cl?.setpoint === 21, `Consigne : ${cl?.setpoint} °C`);
  ok(cl?.demand === true, `Chauffe en ce moment : ${cl?.demand}`);
}

{
  // Une MEME entite meteo nourrit deux equipements differents, chacun prenant
  // l'attribut qui correspond a sa grandeur.
  ok(cap('z21.sensor.meteo', 'sensor')?.value === 17.5, `Météo, température : ${cap('z21.sensor.meteo', 'sensor')?.value} °C`);
  ok(cap('z21.sensor.humidite', 'sensor')?.value === 87, `Météo, humidité : ${cap('z21.sensor.humidite', 'sensor')?.value} %`);
}

// --- 4. la decouverte -------------------------------------------------------
{
  const candidats = adaptateur.candidates();
  const grenier = candidats.find((c) => c.source === 'light.grenier');
  ok(Boolean(grenier), `L'entité non adoptée devient un candidat : ${candidats.length} au total`);
  ok(/Grenier/.test(grenier?.sample ?? ''), `Le candidat porte son nom lisible : « ${grenier?.sample} »`);
  ok(
    !candidats.some((c) => c.source === 'light.salon'),
    'Une entité DÉJÀ adoptée ne figure pas dans les candidats',
  );
}

// --- 5. le direct -----------------------------------------------------------
{
  diffuser('cover.veranda', 'closing', { current_position: 35 });
  await pause(200);
  const c = cap('z03.cover.veranda', 'cover');
  ok(c?.position === 35 && c?.moving === 'down', `Volet qui se ferme : ${c?.position} %, moving = ${c?.moving}`);

  diffuser('light.salon', 'off', {});
  await pause(200);
  ok(cap('z03.light.general', 'switch')?.state === false, 'Extinction reçue par le flux');
}

// --- 6. les commandes -------------------------------------------------------
{
  servicesAppeles.length = 0;

  await adaptateur.command(DEVICES[0], { kind: 'switch', state: true });
  await pause(120);
  const a1 = servicesAppeles.at(-1);
  ok(a1?.domain === 'light' && a1?.service === 'turn_on', `Allumer : ${a1?.domain}.${a1?.service}`);

  await adaptateur.command(DEVICES[0], { kind: 'dim', level: 40 });
  await pause(120);
  const a2 = servicesAppeles.at(-1);
  // `brightness_pct` et non `brightness` : on laisse Home Assistant convertir,
  // ce qui evite un second arrondi et donc la derive du curseur.
  ok(a2?.data?.brightness_pct === 40, `Variation en pourcentage : ${JSON.stringify(a2?.data)}`);

  await adaptateur.command(DEVICES[1], { kind: 'cover', position: 0 });
  await pause(120);
  ok(servicesAppeles.at(-1)?.service === 'close_cover', `Fermeture complète : ${servicesAppeles.at(-1)?.service}`);

  await adaptateur.command(DEVICES[1], { kind: 'cover', position: 55 });
  await pause(120);
  const a4 = servicesAppeles.at(-1);
  ok(a4?.service === 'set_cover_position' && a4?.data?.position === 55, `Position partielle : ${JSON.stringify(a4?.data)}`);

  await adaptateur.command(DEVICES[4], { kind: 'climate', setpoint: 20.5 });
  await pause(120);
  ok(servicesAppeles.at(-1)?.data?.temperature === 20.5, `Consigne envoyée : ${servicesAppeles.at(-1)?.data?.temperature}`);

  await adaptateur.command(DEVICES[1], { kind: 'cover-stop' });
  await pause(120);
  ok(servicesAppeles.at(-1)?.service === 'stop_cover', `Arrêt en pleine course : ${servicesAppeles.at(-1)?.service}`);
}

// --- 7. l'etat ne s'invente pas ---------------------------------------------
{
  // On eteint la lumiere cote modele, puis on commande l'allumage SANS que le
  // faux Home Assistant ne diffuse quoi que ce soit. L'etat doit rester
  // eteint : c'est la regle d'or du projet, et c'est ici qu'elle se verifie.
  diffuser('light.salon', 'off', {});
  await pause(200);
  await adaptateur.command(DEVICES[0], { kind: 'switch', state: true });
  await pause(300);
  ok(
    cap('z03.light.general', 'switch')?.state === false,
    "Après une commande réussie mais sans retour du matériel, l'état reste celui du matériel",
  );

  // Et quand Home Assistant confirme, alors seulement l'etat bouge.
  diffuser('light.salon', 'on', { brightness: 255 });
  await pause(200);
  const sw = cap('z03.light.general', 'switch');
  const dim = cap('z03.light.general', 'dim');
  ok(sw?.state === true && dim?.level === 100, `Confirmé par le flux : allumé à ${dim?.level} %`);
}

// --- 8. la reprise apres coupure --------------------------------------------
{
  socketCourant?.close();
  await pause(1800);
  const etat = adaptateur.status().state;
  ok(etat === 'connected', `Reprise automatique après coupure : ${etat}`);

  // Et le flux repart : un evenement diffuse apres la reprise doit arriver.
  diffuser('sensor.ext', '12.9', {});
  await pause(250);
  ok(cap('z21.sensor.temp', 'sensor')?.value === 12.9, `Flux rétabli : ${cap('z21.sensor.temp', 'sensor')?.value} °C`);
}

await adaptateur.stop();
serveur.close();
process.exit(process.exitCode ?? 0);
