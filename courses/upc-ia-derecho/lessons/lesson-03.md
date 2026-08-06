# Clase 3 — MCP (Model Context Protocol)

**Fecha:** 12 de mayo de 2026
**Estado:** completed
**Grabación:** https://vimeo.com/1001001003 (contraseña: upc-ia-2026)

## TL;DR
MCP es un estándar que permite conectar el modelo (Claude) con fuentes de datos y herramientas externas de forma segura, sin que el modelo acceda directamente a tus sistemas. La analogía del curso: el modelo es el comensal, el servidor MCP es el mozo, tus datos son la cocina.

## Temas tratados

### ¿Qué es MCP? La analogía del restaurante (min 24:29)
El modelo no entra a tu base de datos. Le pide al servidor MCP la información, y el servidor decide qué entregar. Esto da control y seguridad.

### Conectar Claude a fuentes jurídicas (min 38:15)
Ejemplos: un servidor MCP que consulta una base de jurisprudencia, otro que lee los expedientes de un estudio.

### Servidores MCP locales vs remotos (min 51:40)
- **Locales:** corren en tu máquina, ideales para datos sensibles.
- **Remotos:** servicios en la nube, más fáciles de compartir pero requieren cuidar la privacidad.

## Momentos clave
- min 24:29 — La analogía del mozo y la cocina (cita destacada).
- min 51:40 — Cuándo elegir local vs remoto según la sensibilidad de los datos.

## Tarea
Identificar una fuente de datos del propio trabajo que se beneficiaría de un servidor MCP y describir qué entregaría.
