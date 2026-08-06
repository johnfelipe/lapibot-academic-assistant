# Clase 4 — Skills de Claude

**Fecha:** 14 de mayo de 2026
**Estado:** completed
**Grabación:** https://vimeo.com/1001001004 (contraseña: upc-ia-2026)

## TL;DR
Un Skill es un procedimiento reutilizable que le enseñas al modelo una sola vez para que lo ejecute bien siempre. No es un prompt más largo: es una metodología empaquetada con instrucciones y, opcionalmente, ejemplos y recursos.

## Temas tratados

### ¿Qué es un Skill y cuándo crearlo? (min 10:05)
Cuando repites la misma tarea con el mismo criterio una y otra vez, conviene convertirla en Skill.

### Estructura de un Skill (min 22:35)
La estructura básica de archivos:
```
mi-skill/
├── SKILL.md          ← las instrucciones (metodología)
├── description.txt   ← cuándo activarlo (trigger)
└── references/
    └── ejemplo.md    ← ejemplo de salida deseada
```
- **SKILL.md:** el paso a paso de cómo ejecutar.
- **description:** las palabras clave que activan el Skill.

### Skill para análisis de jurisprudencia peruana (min 40:50)
Demostración de un Skill que estructura el análisis de una sentencia: hechos, fundamentos, decisión y ratio decidendi.

## Momentos clave
- min 11:40 — "Un Skill no es un prompt más largo. Es enseñarle al modelo un procedimiento."
- min 40:50 — Demostración del Skill de análisis de jurisprudencia.

## Tarea
Diseñar en papel un Skill para una tarea repetitiva propia: qué haría el SKILL.md y cuál sería su description.
