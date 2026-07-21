@echo off
title Agente Impresion Xabor
color 0A
echo.
echo  ================================================
echo    AGENTE DE IMPRESION XABOR - Iniciando...
echo  ================================================
echo.
echo  Conectando al servidor Railway...
echo  La ventana debe permanecer abierta para imprimir.
echo  Cierra esta ventana para detener la impresion.
echo.
cd /d "C:\xabor-agent"
node print-agent.js
pause/**
 * Agente de Impresión Local — Xabor
 * Conecta al servidor Railway via WebSocket y imprime comandas automáticamente.
 *
 * Uso: node print-agent.js
 * Requiere: npm install ws (ya instalado en el proyecto)
 */

import WebSocket from 'ws';
import { exec } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Configuración ───────────────────────────────────────────────────────────
const WS_URL       = 'wss://xabor-agent-production.up.railway.app';
const PRINTER_NAME = 'POS Printer 203DPI  Series 2';  // Nombre exacto en Windows
const TEMP_DIR     = join(tmpdir(), 'xabor-comandas');
const ANCHO_PAPEL  = 42; // caracteres en papel de 80mm

// ─── Utilidades de formato ───────────────────────────────────────────────────
function centrar(texto, ancho = ANCHO_PAPEL) {
  if (texto.length >= ancho) return texto;
  const pad = Math.floor((ancho - texto.length) / 2);
  return ' '.repeat(pad) + texto;
}

function linea(char = '-', ancho = ANCHO_PAPEL) {
  return char.repeat(ancho);
}

function columnas(izq, der, ancho = ANCHO_PAPEL) {
  const espacio = ancho - izq.length - der.length;
  if (espacio <= 0) return izq + ' ' + der;
  return izq + ' '.repeat(espacio) + der;
}

function wrap(texto, ancho = ANCHO_PAPEL) {
  if (texto.length <= ancho) return texto;
  const palabras = texto.split(' ');
  const lineas = [];
  let lineaActual = '';
  for (const palabra of palabras) {
    if ((lineaActual + ' ' + palabra).trim().length <= ancho) {
      lineaActual = (lineaActual + ' ' + palabra).trim();
    } else {
      if (lineaActual) lineas.push(lineaActual);
      lineaActual = palabra;
    }
  }
  if (lineaActual) lineas.push(lineaActual);
  return lineas.join('\n');
}

// ─── Formatear comanda ───────────────────────────────────────────────────────
function formatearComanda(pedido) {
  const ahora = new Date().toLocaleString('es-MX', {
    timeZone: 'America/Matamoros',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const esEntrega = pedido.modalidad === 'entrega a domicilio';
  const lines = [];

  lines.push('');
  lines.push(centrar('*** XABOR MARKET ***'));
  lines.push(centrar('Focaccias & Mas'));
  lines.push(linea('='));
  lines.push(centrar(pedido.modalidad?.toUpperCase() || 'PEDIDO'));
  lines.push(`Fecha: ${ahora}`);
  lines.push(`Pedido #${pedido.id || '---'}`);
  lines.push(linea('-'));

  // Cliente
  lines.push(`Cliente: ${pedido.cliente?.nombre || 'Sin nombre'}`);
  lines.push(`Tel: ${pedido.cliente?.telefono || '---'}`);

  // Direccion (solo entrega)
  if (esEntrega && pedido.cliente?.calle) {
    lines.push(linea('-'));
    lines.push('DIRECCION DE ENTREGA:');
    lines.push(pedido.cliente.calle);
    if (pedido.cliente.colonia) lines.push(`Col. ${pedido.cliente.colonia}`);
    if (pedido.cliente.entre_calles) {
      lines.push(wrap(`Ref: ${pedido.cliente.entre_calles}`));
    }
  }

  lines.push(linea('='));
  lines.push('PRODUCTOS:');
  lines.push(linea('-'));

  // Items
  for (const item of (pedido.items || [])) {
    const nombre = `${item.cantidad}x ${item.nombre}`;
    const precio = `$${(item.precio_unitario * item.cantidad).toFixed(0)}`;
    lines.push(columnas(nombre, precio));
    if (item.notas) {
      lines.push(wrap(`  >> ${item.notas}`, ANCHO_PAPEL - 2));
    }
  }

  lines.push(linea('-'));

  // Totales
  lines.push(columnas('Subtotal:', `$${pedido.subtotal || 0}`));
  if (esEntrega) {
    lines.push(columnas('Envio:', `$${pedido.costo_envio || 60}`));
  }
  if (pedido.descuento > 0) {
    lines.push(columnas('Descuento:', `-$${pedido.descuento}`));
  }
  lines.push(linea('='));
  lines.push(columnas('TOTAL:', `$${pedido.total || 0}`));
  lines.push(linea('='));

  // Canal
  if (pedido.canal) {
    lines.push(centrar(`Canal: ${pedido.canal}`));
  }

  lines.push('');
  lines.push(centrar('Gracias por tu pedido!'));
  lines.push('');
  lines.push('');
  lines.push('');

  return lines.join('\n');
}

// ─── Imprimir comanda ────────────────────────────────────────────────────────
function imprimirComanda(pedido) {
  const texto = formatearComanda(pedido);
  const nombreArchivo = join(TEMP_DIR, `comanda_${pedido.id || Date.now()}.txt`);

  try {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(nombreArchivo, texto, 'utf8');

    // Imprimir via PowerShell (mas confiable que el comando print de CMD)
    const cmd = `powershell -Command "Get-Content '${nombreArchivo}' | Out-Printer -Name '${PRINTER_NAME}'"`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error(`[Print] Error al imprimir pedido ${pedido.id}:`, err.message);
        // Intento alternativo con print de CMD
        const cmd2 = `print /D:"${PRINTER_NAME}" "${nombreArchivo}"`;
        exec(cmd2, (err2) => {
          if (err2) console.error('[Print] Fallo tambien el intento alternativo:', err2.message);
          else console.log(`[Print] Pedido ${pedido.id} impreso (fallback CMD)`);
        });
      } else {
        console.log(`[Print] Pedido ${pedido.id || 'nuevo'} impreso correctamente`);
      }
    });
  } catch (e) {
    console.error('[Print] Error al crear archivo temporal:', e.message);
  }
}

// ─── WebSocket — Conectar al servidor Railway ────────────────────────────────
let ws;
let intentos = 0;

function conectar() {
  intentos++;
  console.log(`[WS] Conectando a ${WS_URL}... (intento ${intentos})`);

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    intentos = 0;
    console.log('[WS] Conectado al servidor Xabor en Railway');
    console.log('[WS] Esperando pedidos para imprimir...');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.tipo === 'nuevo_pedido') {
        const p = msg.pedido;
        console.log(`[WS] Nuevo pedido recibido: #${p.id} - ${p.cliente?.nombre} - $${p.total}`);
        imprimirComanda(p);
      } else if (msg.tipo === 'estado_actualizado') {
        console.log(`[WS] Estado actualizado: pedido #${msg.pedidoId} -> ${msg.estado}`);
      }
    } catch (e) {
      console.error('[WS] Error al parsear mensaje:', e.message);
    }
  });

  ws.on('close', (code) => {
    const espera = Math.min(30, intentos * 5);
    console.log(`[WS] Conexion cerrada (${code}). Reconectando en ${espera}s...`);
    setTimeout(conectar, espera * 1000);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
}

// ─── Inicio ──────────────────────────────────────────────────────────────────
console.log('');
console.log('Agente de Impresion Xabor');
console.log(`   Impresora: ${PRINTER_NAME}`);
console.log(`   Servidor:  ${WS_URL}`);
console.log('');

conectar();
