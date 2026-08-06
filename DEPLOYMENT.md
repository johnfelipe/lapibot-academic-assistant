# Lapibot — Resumen del Despliegue

Este documento describe el estado del despliegue público de **Lapibot**, el asistente de cursos para WhatsApp del repositorio `lapibot-academic-assistant`.

## Qué es Lapibot

Lapibot **no es una aplicación web con interfaz visual**. Es un *bot de WhatsApp* compuesto por dos servicios que corren en contenedores Docker:

1. **WAHA** (WhatsApp HTTP API) — el puente con WhatsApp. Recibe los mensajes y los reenvía como *webhooks* a la app.
2. **App (Lapibot)** — un servidor Express en Node.js/TypeScript que procesa los webhooks, ejecuta el bucle agéntico con la API de Claude (Anthropic) y responde a través de WAHA.

El bot solo responde cuando es **@mencionado en grupos de WhatsApp** registrados, o en **mensajes directos de estudiantes inscritos** (verificados contra un `participants.csv`).

**Idioma:** Lapibot fue adaptado para operar en **español** (originalmente en hebreo). Se tradujeron el `system-prompt.md`, todos los mensajes/strings de la app, las cabeceras esperadas del `participants.csv` y la configuración del curso demo. Las nuevas cabeceras del CSV de participantes son: `nombre, apellido, telefono` (o `celular`), `titulo`, `area de practica`, `herramientas de IA`, `notas`.

## Estado actual

| Componente | Estado |
|---|---|
| Repositorio clonado | Hecho |
| Dependencias instaladas (`npm install`) | Hecho |
| Compilación TypeScript (`npm run build`) | Hecho |
| Imagen Docker de la app construida | Hecho |
| Contenedor WAHA en ejecución | Hecho (`healthy`) |
| Contenedor de la app en ejecución | Hecho (`healthy`) |
| Conexión App ↔ WAHA | Verificada (`/health` = `ok`) |
| API de Claude (Anthropic) | Configurada con la clave proporcionada |
| Sesión de WhatsApp | `SCAN_QR_CODE` — pendiente de escanear el QR |
| Curso de ejemplo | Creado (`courses/demo-course`) |

## URLs públicas

- **API de la app (health / webhook):** https://3001-ihxzimmyo59nllulegvb7-85b2e4a6.us2.manus.computer
  - `GET /health` — estado del servicio
  - `POST /webhook` — recepción de webhooks de WAHA (uso interno)
- **Dashboard / API de WAHA:** https://3000-ihxzimmyo59nllulegvb7-85b2e4a6.us2.manus.computer/dashboard
  - **Usuario del dashboard:** `admin`
  - **Contraseña del dashboard:** `lapibot2026`
  - Clave de API de WAHA (`X-Api-Key`): `lapibot_waha_6424bded568e2fc8`

## Cómo activar WhatsApp (escanear el QR)

La sesión de WhatsApp está esperando a que se vincule un teléfono. Tienes dos opciones:

1. **Vía dashboard de WAHA (recomendado):** abre el dashboard, inicia sesión y escanea el QR de la sesión `default` desde *WhatsApp > Dispositivos vinculados > Vincular dispositivo*.
2. **Vía imagen del QR adjunta:** el archivo `lapibot-whatsapp-qr.png` contiene el código QR actual. Escanéalo directamente desde WhatsApp. (El QR caduca tras un tiempo corto; si expira, vuelve a generarlo desde el dashboard o el endpoint `GET /api/default/auth/qr?format=image`.)

Tras escanear, el estado pasará a `WORKING` y el bot quedará operativo con tu número y tu clave de Claude.

## Limitaciones de este despliegue (importante)

- **Imagen WAHA Core (gratuita):** el repositorio original usa `waha-plus` (de pago). Aquí se desplegó la versión `waha:noweb` Core. Funciones avanzadas de Plus (p. ej. ciertas resoluciones de LID/medios) pueden diferir.
- **Materiales del curso privados:** el bot lee el contenido real (resúmenes, transcripciones, `participants.csv`) desde un repositorio privado separado que **no** está incluido. Se creó un `demo-course` mínimo para que la app cargue sin errores, pero el bot no tendrá contenido real que consultar hasta que montes los materiales en `courses/`.
- **Webhook de GitHub deshabilitado:** el auto-actualizado de cursos (puerto 3002) está desactivado por no haberse configurado `GITHUB_WEBHOOK_SECRET` ni `GITHUB_COURSES_REPO`.
- **Entorno temporal (sandbox):** este despliegue corre en un sandbox que puede hibernar. Para un servicio 24/7 estable conviene un VPS/servidor persistente, tal como describe el README original.

## Seguridad

- La **clave de API de Anthropic** se compartió en texto plano por el chat. Se recomienda **revocarla y rotarla** tras las pruebas.
- La clave de WAHA fue generada localmente para esta instancia.

## Comandos útiles (en el sandbox)

```bash
# Ver estado de los contenedores
sudo docker ps

# Logs de la app
sudo docker logs -f lapibot-app

# Logs de WAHA
sudo docker logs -f waha

# Reiniciar la sesión de WhatsApp (regenerar QR)
WKEY=lapibot_waha_6424bded568e2fc8
curl -X POST -H "X-Api-Key: $WKEY" http://localhost:3000/api/sessions/default/restart
```
