/**
 * Libère les ports du projet.
 *
 * Un serveur laissé en fond après un plantage bloque le démarrage suivant avec
 * un EADDRINUSE cryptique. Plutôt que de chercher le PID à la main, on le fait
 * ici, et `npm run dev` le fait tout seul avant de démarrer.
 */
import { execSync } from 'node:child_process';

const PORTS = [Number(process.env.PORT ?? 3001), 5173, 5174];
let liberes = 0;

for (const port of PORTS) {
  let pids = [];
  try {
    pids = execSync(`lsof -ti:${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n').filter(Boolean);
  } catch {
    continue; // personne sur ce port : c'est le cas normal
  }

  for (const pid of pids) {
    // On ne tue jamais le processus courant ni son parent : sur un lancement
    // concurrent, ce serait se couper le tapis sous les pieds.
    if (Number(pid) === process.pid || Number(pid) === process.ppid) continue;
    try {
      process.kill(Number(pid), 'SIGTERM');
      liberes++;
      console.log(`[ports] ${port} libéré (PID ${pid})`);
    } catch {
      /* déjà parti */
    }
  }
}

if (liberes) {
  // Laisser le temps aux sockets de se fermer avant que le suivant écoute.
  await new Promise((r) => setTimeout(r, 600));
}
