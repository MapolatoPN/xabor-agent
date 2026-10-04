// Fase 2B de la tienda (tienda_v1): con la bandera apagada TODO es igual que
// en la base de la rama. Compara, byte a byte, lo que arma el código de hoy
// (el src/ de la base, be1e4d0 o BASE_TIENDA) con lo que arma este checkout:
// la foto de cada formulario, el formulario que sale al chat, la vigencia, los
// comandos del recibo, el recibo final del endpoint, el retomar, la
// telemetría, la vista del panel y las listas blancas del endpoint y del
// transporte. Pura (sin base, Meta ni red), pero necesita git: no corre en la
// imagen productiva (por eso check-tienda-plomeria.mjs prueba, además, que la
// bandera apagada es idéntica a no tener sus claves).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as F from '../scripts/fixture-tienda-plomeria.mjs';
import { CONTRATO_DIRECCION } from '../src/mesero-agente/direccionFormulario.js';
import { CONTRATO_NOTA } from '../src/mesero-agente/notaDelPedido.js';

const raiz = fileURLToPath(new URL('../', import.meta.url));
const BASE = process.env.BASE_TIENDA || 'be1e4d0';
let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => { try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); } catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${e.message}`); } };
const json = (v) => JSON.stringify(v);

// El src/ de la base, dentro del checkout (así resuelve el mismo node_modules).
// Una sola llamada a git: cat-file --batch con todos los archivos.
const destino = mkdtempSync(join(raiz, '.base-tienda-'));
try {
  const archivos = execFileSync('git', ['ls-tree', '-r', '--name-only', BASE, 'src'], { cwd: raiz, encoding: 'utf8' }).split('\n').filter(Boolean);
  const salida = spawnSync('git', ['cat-file', '--batch'], { cwd: raiz, input: archivos.map((a) => `${BASE}:${a}`).join('\n') + '\n', maxBuffer: 1 << 30 });
  assert.equal(salida.status, 0, String(salida.stderr));
  let pos = 0;
  for (const archivo of archivos) {
    const fin = salida.stdout.indexOf(10, pos), cabecera = salida.stdout.subarray(pos, fin).toString('utf8');
    const m = /^[0-9a-f]{40} blob (\d+)$/.exec(cabecera);
    assert(m, `git cat-file: ${cabecera}`);
    const tam = Number(m[1]), contenido = salida.stdout.subarray(fin + 1, fin + 1 + tam);
    mkdirSync(dirname(join(destino, archivo)), { recursive: true });
    writeFileSync(join(destino, archivo), contenido);
    pos = fin + 1 + tam + 1;
  }
  const viejo = async (r) => import(pathToFileURL(join(destino, r)).href);
  const nuevo = async (r) => import(pathToFileURL(join(raiz, r)).href);
  const [Vf, Nf] = [await viejo('src/mesero-agente/formularioAgrupado.js'), await nuevo('src/mesero-agente/formularioAgrupado.js')];
  const [Vn, Nd] = [await viejo('src/mesero-agente/notaDelPedido.js'), await nuevo('src/mesero-agente/disponibilidadTienda.js')];
  const [Vs, Ns] = [await viejo('src/mesero-agente/flowRepetibleSql.js'), await nuevo('src/mesero-agente/flowRepetibleSql.js')];
  const [Va, Na] = [await viejo('src/mesero-agente/actividadFormulario.js'), await nuevo('src/mesero-agente/actividadFormulario.js')];
  const [Vg, Ng] = [await viejo('src/services/seguimientoFormulario.js'), await nuevo('src/services/seguimientoFormulario.js')];
  const [Vr, Nr] = [await viejo('src/mesero-agente/recuperarBorradorFlow.js'), await nuevo('src/mesero-agente/recuperarBorradorFlow.js')];
  const [Vt, Nt] = [await viejo('src/mesero-agente/transporteInteractivo.js'), await nuevo('src/mesero-agente/transporteInteractivo.js')];
  const [Vc, Nc] = [await viejo('src/mesero-agente/flowCarrito.js'), await nuevo('src/mesero-agente/flowCarrito.js')];

  const ctxDe = (cfg, estado, telefono = F.TELEFONO) => ({ estado, catalogo: F.carta(), modalidades: F.modalidades,
    metodosPago: F.metodosPago, reglas: F.reglas, cfg, telefono });
  // Las configuraciones de hoy con la bandera apagada de cada forma, y la de
  // prueba para un cliente que no está en la lista.
  const BASES = [F.cfgHoy, { ...F.cfgHoy, whatsapp_carrito_unificado_v1: 'false' }, { ...F.cfgHoy, whatsapp_flow_nota_v1: 'false' },
    { ...F.cfgHoy, whatsapp_flow_categorias_dir_id: '', whatsapp_flow_carrito_dir_id: '', whatsapp_flow_nota_v1: '' },
    { ...F.cfgHoy, whatsapp_flow_categorias_id: '', whatsapp_flow_repetible_id: '33333333333' }];
  const APAGADAS = [{}, { whatsapp_flow_tienda_v1: 'false', whatsapp_flow_tienda_id: F.IDS.tienda }, { whatsapp_flow_tienda_v1: 'TRUE', whatsapp_flow_tienda_id: F.IDS.tienda },
    { whatsapp_flow_tienda_id: F.IDS.tienda }, { whatsapp_flow_tienda_v1: 'true' },
    { whatsapp_flow_tienda_v1: 'prueba', whatsapp_flow_tienda_id: F.IDS.tienda, whatsapp_flow_tienda_telefonos: F.OTRO_TELEFONO }];
  const combinaciones = BASES.flatMap((b, i) => APAGADAS.map((a, j) => [`base ${i} · apagada ${j}`, { ...b, ...a }]));

  for (const entorno of ['con endpoint', 'sin endpoint']) {
    const correr = entorno === 'con endpoint' ? F.conEntornoFlows : async (fn) => fn();
    await correr(() => t(`(${entorno}) foto, formulario armado, vigencia y comandos: los mismos bytes que la base`, async () => {
      let n = 0;
      for (const [nombre, cfg] of combinaciones) {
        for (const [escenario, accion, mk] of F.ESCENARIOS) {
          const donde = `${nombre} · ${escenario}`;
          const v = Vf.fotoFormulario(ctxDe(cfg, mk()), accion), nf = Nf.fotoFormulario(ctxDe(cfg, mk()), accion);
          // Única diferencia intencional (4-oct, no es de la tienda): ningún formulario abre ya
          // en la dirección, porque el teléfono rechaza un INIT en otra pantalla que no sea la
          // primera. «Tu carrito» con la pregunta de dirección deja de llevar `abrir` y su
          // invitación dice el camino («Abrir carrito»); todo lo demás, idéntico.
          const abriaDireccion = v?.version === 'carrito_v1' && v?.abrir === 'DIRECCION';
          const invitaDireccion = v?.version === 'carrito_v1' && v?.contrato === CONTRATO_DIRECCION && mk().pendiente?.tipo === 'direccion';
          const sinAbrir = (f) => { if (!f) return f; const { abrir, ...resto } = f; return resto; };
          assert.equal(json(nf), json(abriaDireccion ? sinAbrir(v) : v), `${donde}: foto`);
          const armar = (M) => { const e = mk(); return M.construirFormulario({ ...ctxDe(cfg, e), pedido: { huella: 'h', total: 100 }, texto: e.dialogo.texto }); };
          if (invitaDireccion) {
            const fn = F.sinAzar(armar(Nf)), fv = F.sinAzar(armar(Vf));
            assert.match(fn.texto, /^\*Dirección de entrega\*\nEn el formulario toca «Continuar», elige o revisa la entrega y el pago/, donde);
            assert.equal(fn.carga.action.parameters.flow_cta, 'Abrir carrito', donde);
            const comun = (f) => { const c = structuredClone(f); delete c.texto; delete c.carga.body.text; delete c.carga.action.parameters.flow_cta;
              c.botones = c.botones.map((b) => ({ ...b, datos: sinAbrir(b.datos) })); return c; };
            assert.equal(json(comun(fn)), json(comun(fv)), `${donde}: formulario (sin texto, botón ni abrir)`);
          } else assert.equal(json(F.sinAzar(armar(Nf))), json(F.sinAzar(armar(Vf))), `${donde}: formulario`);
          if (v) {
            assert.equal(Nf.formularioVigente({ accion, datos: v }, ctxDe(cfg, mk())), Vf.formularioVigente({ accion, datos: v }, ctxDe(cfg, mk())), `${donde}: vigencia`);
            // El recibo de un «Tu carrito» o «Arma tu pedido» intacto.
            const recibo = v.version === 'carrito_v1' ? { flow_token: 'tk', filas: Vc.borradorCarrito(v).filas, modalidad: 'm0', pago: 'p0' }
              : v.version === 'repetible_v1' ? { flow_token: 'tk', items: [{ producto0: 'p2', cantidad: '1' }], modalidad: 'm0', pago: 'p0' } : null;
            if (recibo) {
              assert.equal(json(Nf.comandosFormulario(v, recibo)), json(Vf.comandosFormulario(v, recibo)), `${donde}: comandos`);
              const ctxV = ctxDe(cfg, mk()), ctxN = ctxDe(cfg, mk());
              const [rv, rn] = [await Vf.aplicarFormulario({ accion, datos: v, respuestaFlow: recibo }, ctxV), await Nf.aplicarFormulario({ accion, datos: v, respuestaFlow: recibo }, ctxN)];
              assert.equal(rn.ok, rv.ok, `${donde}: aplicar`);
              const sinLid = (c) => json({ ...c, items: c.items.map((i) => ({ ...i, lid: /^(L1|L2|C\d+)$/.test(i.lid) ? i.lid : 'nuevo' })) });
              assert.equal(sinLid(ctxN.estado.carrito), sinLid(ctxV.estado.carrito), `${donde}: carrito aplicado`);
            }
          }
          n++;
        }
      }
      assert(n >= 360, `${n} combinaciones`);
    }));
  }
  await t('endpoint y transporte: flowId esperado, listas con endpoint y barreras de dirección y nota iguales a la base', () => {
    const fotos = [{ version: 'carrito_v1' }, { version: 'carrito_v1', contrato: CONTRATO_DIRECCION },
      { version: 'carrito_v1', contrato: CONTRATO_DIRECCION, contrato_nota: CONTRATO_NOTA }, { version: 'repetible_v1' },
      { version: 'repetible_v1', presentacion: 'categorias_v1' }, { version: 'repetible_v1', presentacion: 'categorias_v1', contrato: CONTRATO_DIRECCION },
      { version: 'repetible_v1', presentacion: 'categorias_v1', contrato: CONTRATO_DIRECCION, contrato_nota: CONTRATO_NOTA },
      { version: 'edicion_v1' }, { version: 'continuo_v1' }, {}];
    for (const [nombre, cfg] of combinaciones) {
      if (nombre.endsWith('apagada 5')) continue; // prueba: la tienda existe para otro cliente (abajo)
      assert.deepEqual(Nd.flowIdsConEndpointFormularios(cfg), Vn.flowIdsConEndpointConNota(cfg), nombre);
      for (const d of fotos) {
        assert.equal(Nd.flowIdEsperadoFormulario(cfg, d), Vn.flowIdEsperadoConNota(cfg, d), `${nombre} ${json(d)}`);
        assert.equal(Ns.sinDireccionVieja(cfg, d), Vs.sinDireccionVieja(cfg, d), `${nombre} ${json(d)}`);
        for (const tel of [F.TELEFONO, F.OTRO_TELEFONO]) assert.equal(Nd.sinTiendaVieja(cfg, d, tel), false, `${nombre} ${json(d)}`);
      }
    }
    // Para el cliente fuera de la prueba: mismo flowId esperado y ninguna barrera nueva.
    const prueba = combinaciones.find(([n]) => n === 'base 0 · apagada 5')[1];
    for (const d of fotos) {
      assert.equal(Nd.flowIdEsperadoFormulario(prueba, d), Vn.flowIdEsperadoConNota(prueba, d), json(d));
      assert.equal(Nd.sinTiendaVieja(prueba, d, F.TELEFONO), false, json(d));
    }
    assert.deepEqual(Nd.flowIdsConEndpointFormularios(prueba), [...Vn.flowIdsConEndpointConNota(prueba), F.IDS.tienda], 'solo agrega el de la tienda');
    for (const [, cfg] of combinaciones) {
      const carga = { type: 'flow', body: { text: 'x' }, action: { name: 'flow', parameters: { flow_message_version: '3', flow_token: 'xb1:aaaaaaaaaaaaaaaaaaaaaa',
        flow_id: F.IDS.carritoNota, flow_cta: 'Abrir carrito', flow_action: 'data_exchange' } } };
      assert.equal(Nt.payloadInteractivoValido(carga, 'x'), Vt.payloadInteractivoValido(carga, 'x'));
    }
  });
  await t('recibo final, retomar, telemetría y panel: iguales a la base para carrito_v1 y repetible_v1', async () => {
    const carrito = { version: 'carrito_v1', contrato: CONTRATO_DIRECCION, contrato_nota: CONTRATO_NOTA,
      modalidades: [{ valor: 'recoger en tienda' }, { valor: 'entrega a domicilio' }], productos: [{ nombre: 'Café', grupos: [] }] };
    const repetible = { ...carrito, version: 'repetible_v1', presentacion: 'categorias_v1' };
    const borradores = [{ etapa: 'FINAL', revision: 4, filas: [{ key: 'e0', item: { producto0: 'p0', cantidad: '2' } }], modalidad: 'm1', pago: 'p0',
      direccion: { calle: 'Hidalgo 405', colonia: '', referencias: '', zona: 'zn' }, nota: 'Timbre' },
    { etapa: 'FINAL', revision: 2, items: [{ producto0: 'p0', cantidad: '1' }], modalidad: 'm0', pago: 'p0', nota: '' },
    { etapa: 'ENTREGA', revision: 3, filas: [] }];
    for (const foto of [carrito, repetible, { version: 'edicion_v1' }]) {
      for (const d of borradores) {
        const tx = { query: async () => ({ rows: [{ contenido: d }] }) };
        for (const r of [{ flow_token: 'tk', revision: String(d.revision) }, { flow_token: 'tk', revision: '9' }, { flow_token: 'tk', revision: String(d.revision), x: 1 }]) {
          assert.equal(json(await Ns.resolverFinalFlow(tx, { id: 'q', datos: foto }, r)), json(await Vs.resolverFinalFlow(tx, { id: 'q', datos: foto }, r)), `${foto.version} ${d.etapa}`);
        }
        assert.equal(json(Ng.vistaRespuestaFormulario(foto, d)), json(Vg.vistaRespuestaFormulario(foto, d)), `${foto.version} panel`);
      }
    }
    const clave = 'b'.repeat(64);
    for (const etapa of ['MENU', 'PLATILLO', 'TACOS', 'ENTREGA', 'CARRITO', 'EDITAR', 'DIRECCION', 'FINAL', 'TIENDA', null]) {
      for (const s of [{ action: 'INIT' }, { action: 'data_exchange' }, { action: 'BACK' }, { action: 'data_exchange', data: { error: 'x' } }, { action: 'ping' }]) {
        for (const paso of [{ borrador: { revision: 1, etapa } }, { borrador: { revision: 1, etapa }, error: 'e' }, { borrador: { revision: -1, etapa } }]) {
          assert.equal(json(Na.eventoActividadFormulario(s, paso, clave)), json(Va.eventoActividadFormulario(s, paso, clave)), `${etapa} ${s.action}`);
        }
      }
    }
    for (const fila of [{ eventos: [{ tipo: 'paso', paso: 'CARRITO', observado_at: new Date().toISOString() }], estado: 'disponible', created_at: new Date().toISOString() },
      { eventos: [{ tipo: 'paso', paso: 'DIRECCION', observado_at: new Date().toISOString() }], estado: 'terminada', resultado: { formulario_aplicado: true } }]) {
      assert.equal(json(Ng.seguimientoFormulario(fila, { ahora: 0 })), json(Vg.seguimientoFormulario(fila, { ahora: 0 })));
    }
    const consultas = (M) => { const c = []; return { c, db: { query: async (sql, args) => { c.push([sql, args]); return { rows: [] }; } } }; };
    for (const [accion, version] of [['flow_configurar', 'carrito_v1'], ['flow_productos', 'repetible_v1'], ['flow_configurar', 'edicion_v1'], ['flow_productos', 'continuo_v1'], ['flow_configurar', undefined]]) {
      const a = consultas(), b = consultas();
      const preparado = { ciclo: 'c', preguntaId: 'p', huella: 'h', botones: [{ accion, datos: { version } }] };
      assert.equal(await Nr.borradorCompatible(a.db, { preparado, negocioId: 'n', sessionId: 's' }), await Vr.borradorCompatible(b.db, { preparado, negocioId: 'n', sessionId: 's' }));
      assert.equal(json(a.c), json(b.c), `${accion} ${version}`);
    }
  });
} finally {
  rmSync(destino, { recursive: true, force: true });
}
console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas} (bandera apagada contra ${BASE})`);
process.exit(fallidas ? 1 : 0);
