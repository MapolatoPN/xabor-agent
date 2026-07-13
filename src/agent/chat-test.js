#!/usr/bin/env node
// Script para probar el agente en la terminal
// Uso: npm run chat

import 'dotenv/config';
import readline from 'readline';
import { procesarMensaje } from './brain.js';
import { registrarPedido } from '../orders/orderManager.js';
// Generamos un ID de sesión único para esta prueba
const sessionId = `test-${Date.now()}`;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('\n' + '🌮'.repeat(20));
console.log('  AGENTE XABOR — Modo prueba en terminal');
console.log('  Escribe "salir" para terminar');
console.log('🌮'.repeat(20) + '\n');

// Iniciamos la conversación con un saludo automático
async function iniciar() {
  try {
    const respuestaInicial = await procesarMensaje(sessionId, 'Hola');
    console.log(`\n🤖 Xabor: ${respuestaInicial.texto}\n`);
    preguntarAlUsuario();
  } catch (error) {
    console.error('Error al iniciar:', error.message);
    if (error.message.includes('API')) {
      console.error('\n⚠️  Verifica que ANTHROPIC_API_KEY esté configurada en el archivo .env\n');
    }
    process.exit(1);
  }
}

function preguntarAlUsuario() {
  rl.question('👤 Tú: ', async (input) => {
    const texto = input.trim();

    if (!texto) {
      preguntarAlUsuario();
      return;
    }

    if (texto.toLowerCase() === 'salir') {
      console.log('\n¡Hasta pronto! 👋\n');
      rl.close();
      process.exit(0);
    }

    try {
      const resultado = await procesarMensaje(sessionId, texto);
      console.log(`\n🤖 Xabor: ${resultado.texto}\n`);

      if (resultado.orden) {
        const pedido = registrarPedido(resultado.orden, 'test');
        console.log(`\n✅ Pedido registrado con ID: ${pedido.id}\n`);
      }

      preguntarAlUsuario();
    } catch (error) {
      console.error('\n❌ Error:', error.message, '\n');
      preguntarAlUsuario();
    }
  });
}

iniciar();
