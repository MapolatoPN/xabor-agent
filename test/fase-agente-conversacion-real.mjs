// Evaluación con proveedor REAL y catálogo exportado en solo lectura.
// No importa el servidor ni el canal. Registro, pagos y emisión no existen
// aquí: solo se inyecta un efecto de confirmación en memoria.
// Uso: ANTHROPIC_API_KEY=... node test/fase-agente-conversacion-real.mjs snapshot.json resultado.json
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { acusarDialogo } from '../src/mesero-agente/contratoConversacional.js';
import { reglasDelAsistenteEnTexto } from '../src/mesero-agente/reglasDelAsistente.js';
import { llamarModeloDelAgente } from '../src/mesero-agente/modeloDelAgente.js';
const [entrada, destino] = process.argv.slice(2);
assert(entrada && destino && process.env.ANTHROPIC_API_KEY, 'Faltan snapshot, resultado o clave del proveedor');
const datos = JSON.parse(readFileSync(entrada, 'utf8').replace(/^\uFEFF/, ''));
let estado = estadoNuevo({ negocioId: 'evaluacion-aislada', conversacionId: 'integral' });
const informe = []; let registros = 0;
const mensajes = datos.mensajes || ['Hola',
  'Quiero chilaquiles suizos con huevos estrellados, frijolitos y papas a la mexicana',
  'Naturales', 'Para recoger, pagaré en efectivo', 'Tienen licuados?',
  'Quiero agregar un licuado', 'Grande de plátano con fresa, chocolate, vainilla y canela',
  'Entera', 'Sin azúcar', 'Sí, confirmo'];
try {
  for (const mensaje of mensajes) {
    const antes = JSON.stringify(estado.carrito);
    const salida = await atenderTurnoConHerramientas({ estado, mensaje, catalogo: datos.catalogo,
      reglas: datos.reglas, metodosPago: datos.metodosPago, zonaDelNegocio: datos.reglas.timezone,
      modalidades: datos.reglas.pedidos.modalidades,
      llamarModelo: (p) => llamarModeloDelAgente({ ...p, model: process.env.MESERO_AGENTE_MODELO || p.model },
        { clave: process.env.ANTHROPIC_API_KEY }),
      efectos: { confirmar: async ({ pedido }) => {
        registros += 1; return { ok: true, folio: 'SIMULADO-SIN-EFECTOS', total: pedido.total };
      }, escalar: async () => ({ ok: true, simulado: true }) },
      contexto: { nombreNegocio: datos.nombre, textoCiclo: mensaje, tono: datos.reglas.bot?.tono,
        reglasDelNegocio: reglasDelAsistenteEnTexto(datos.reglas, { esPrimerTurno: estado.turno === 0 }) },
    });
    informe.push({ cliente: mensaje, texto: salida.texto, pedido: salida.pedido,
      operaciones: salida.operaciones, escalado: salida.escalado, duracionMs: salida.duracionMs });
    console.log(JSON.stringify({ cliente: mensaje, bot: salida.texto, estado: salida.pedido.estado }));
    assert.equal(salida.escalado, false, `Derivación inesperada: ${mensaje}`);
    assert.equal(salida.error, undefined, mensaje);
    if (/frijolitos y papas/i.test(mensaje)) {
      assert(!salida.pedido.lineas.some((l) => l.opciones.some((o) => /^Frijolitos (naturales|con chorizo)$/.test(o.opcion))),
        'El modelo decidió la variante de frijoles sin aclaración del cliente');
      assert.equal(salida.pedido.resumen.completo, false);
    }
    if (/Tienen licuados/i.test(mensaje)) {
      assert.equal(JSON.stringify(estado.carrito), antes, 'Una consulta cambió el carrito');
      assert.match(salida.texto, /licuado/i);
      assert.doesNotMatch(salida.texto, /Tu borrador contiene/);
    }
    assert(salida.pedido.lineas.filter((l) => l.producto === 'Licuado').length <= 1,
      'Una continuación creó otro licuado');
    // Recarga entre CADA turno: la continuidad no puede depender de objetos
    // del proceso ni perder pendientes al serializar el estado.
    assert(acusarDialogo(estado, salida.dialogoId, salida.texto));
    estado = JSON.parse(JSON.stringify(estado));
  }
  assert.equal(registros, 1, 'Debe existir una única confirmación simulada');
  const final = informe.at(-1).pedido;
  assert.equal(final.estado, 'confirmado');
  assert.equal(final.total, datos.totalEsperado ?? 285);
  assert.equal(final.lineas.length, 2);
  const chilaquiles = final.lineas.find((l) => /Chilaquiles/.test(l.producto));
  assert.deepEqual(chilaquiles.opciones.filter((o) => o.grupo === 'Guarniciones').map((o) => o.opcion).sort(),
    ['Frijolitos naturales', 'Papas a la mexicana']);
  const licuado = final.lineas.find((l) => l.producto === 'Licuado');
  assert.equal(licuado.opciones.find((o) => o.grupo === 'Sabor').opcion.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), 'Platano');
  assert.equal(licuado.opciones.find((o) => o.grupo === '¿Fruta Extra?').opcion, 'Fresa');
  assert.equal(final.modalidad, 'recoger en tienda');
  assert.equal(final.forma_pago, 'efectivo');
  console.log('OK conversación completa con modelo real, recarga en cada turno y efectos simulados.');
} finally {
  writeFileSync(destino, JSON.stringify({ registrosSimulados: registros, turnos: informe }, null, 2));
}
