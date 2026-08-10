# Failover de nube

## Objetivo

Que una caída completa de Railway no deje a Xabor sin procesamiento. Y sobre
todo: **no resolver un punto único de fallo creando otro**.

## El grafo de dominios de fallo, hoy

```
Cliente
  │
  ▼
Cloudflare  ············ dominio de fallo 1 (y reescribe el HTML)
  │
  ▼
Railway (una región) ··· dominio de fallo 2
  ├── xabor-agent (1 instancia)
  └── Postgres (1 instancia, mismo proyecto)  ← también dominio 2
```

El detalle que decide todo: **la aplicación y la base comparten dominio de
fallo**. Un incidente regional se lleva a las dos. Por eso "poner dos réplicas"
no responde la pregunta: dos réplicas en la misma región contra la misma base
siguen cayendo juntas.

## Lo que no vale

Mover el procesamiento de WhatsApp a un servicio único en otro proveedor. Eso
cambia el nombre del punto único de fallo, no lo elimina. Y si Postgres sigue
siendo uno, Postgres sigue siendo el punto único aunque haya cuatro workers.

## Forma propuesta

```
Meta
  │
  ▼
Ingreso estable (independiente de Railway)
  │
  ▼
Cola durable
  ├──▶ Worker A (Railway)
  └──▶ Worker B (otro dominio de fallo)
```

El ingreso solo tiene que hacer tres cosas: validar la firma, escribir el
evento y contestar 200. Cuanto menos haga, menos puede romperse. El
procesamiento pesado ocurre después, en workers que pueden morir sin perder
nada.

## Comparativa de opciones (Parte 29)

Sin contratar nada y sin elegir por moda. Las cifras de precio y latencia
**están sin verificar**: esta sesión no tuvo acceso a la documentación oficial
de los proveedores y no se inventan números.

| Opción | A favor | En contra | Sirve para |
|---|---|---|---|
| Segunda región de Railway | mismo flujo, mismo Docker, cambio mínimo | mismo proveedor | región caída, no proveedor caído |
| Segundo proveedor con contenedor | dominio de fallo de verdad distinto | duplica despliegue, secretos, observabilidad | proveedor caído |
| Función en el borde para el ingreso | independiente de Railway, difícil de tumbar | no puede hacer trabajo pesado | recibir sin perder |
| Cola durable gestionada | desacopla recibir de procesar | otra dependencia | picos y caídas |
| Base independiente | quita el último punto único | replicación, coste, complejidad | Postgres caído |

**Recomendación para la siguiente fase:** ingreso en el borde + cola durable,
manteniendo el procesamiento en Railway. Es lo que más resiliencia compra por
lo que menos complica: convierte "Railway caído" en "los eventos se acumulan y
se procesan cuando vuelva", que es un incidente aburrido en vez de una pérdida
de datos.

## Dos workers en local (Parte 57)

Probado sin contratar nada: dos workers contra la misma cola, matando uno a
mitad. El otro vacía el resto y lo que murió en vuelo queda `incierto`, no
reintentado a ciegas. 120 mensajes, ninguno perdido.

## Postgres (Partes 31 y 32)

Hoy: instancia única en Railway, volumen `postgres-volume`, backups lógicos con
`pg_dump -Fc` hechos a mano antes de cada despliegue. **No hay PITR verificado
ni réplica.**

Si la base no responde:

- **Restaurante local: sigue operando.** Probado: 500 operaciones sin nube.
- **WhatsApp entrante:** sin base no hay dónde persistir, y persistir es la
  condición para contestar 200. Lo correcto es **no contestar 200** y dejar que
  Meta reintente, en vez de aceptar y perder. Eso requiere confirmar antes la
  política de reintentos de Meta (bloqueado). La alternativa robusta es una
  cola durable fuera de nuestra base.

Propuesta, sin activar: réplica de lectura, PITR verificado con una
restauración de prueba real, y evaluar una base gestionada en otro dominio de
fallo. Nada de esto se toca sin revisión humana.
