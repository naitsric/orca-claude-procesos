# Procesos de Claude

Un monitor de actividad para [Claude Code](https://claude.com/claude-code) dentro de
[Orca](https://github.com/stablyai/orca). Muestra:

- qué sesiones de `claude` tienes abiertas;
- qué procesos lanzó cada una (servidores MCP, comandos de Bash, servidores de desarrollo, túneles);
- cuáles **quedaron vivos después de que su sesión terminó**.

Cada proceso trae un veredicto, **cerrar**, **revisar** o **dejar**, con su motivo. Desde el panel
puedes cerrarlo.

```
Procesos de Claude                                   ↻
5 sesiones · 41 procesos · 2,4 GB · revisado hace 3 s

┃ 2 procesos huérfanos
┃ Siguieron vivos después de cerrar su sesión de Claude.
┃ Ocupan 49 MB y :15432.        [Cerrar todos]  Ver

 Sesiones (5)   Huérfanos (2)
 › ⚠ api-0e        api · inactiva 21 h · 284 MB · 6 procesos
 › ⚠ web-cb        web · inactiva 14 h · 253 MB · 6 procesos
 ›   refactor-auth api · trabajando · 1,0 GB · 13 procesos
```

## Instalación

Necesitas **Orca 1.4.248 o más reciente, en macOS**, con los plugins activados (Settings →
Plugins → *Turn on plugins*).

**1. Pide la instalación.** Como el plugin corre código, Orca no lo activa sin tu aprobación:
responde con la lista de lo que pide y una huella (`ap1-…`).

```sh
orca plugin install naitsric/orca-claude-procesos
```

**2. Apruébalo con la huella que te dio:**

```sh
orca plugin install naitsric/orca-claude-procesos --approve ap1-xxxxxxxx
```

**3. Ábrelo.** Aparece en la barra lateral derecha como **Procesos de Claude** (icono de
actividad), y en la barra de estado como `Claude N`. También se abre con:

```sh
orca plugin open naitsric.claude-procesos --panel procesos
```

> **¿`orca: command not found`?** El CLI viene dentro de la app:
> `/Applications/Orca.app/Contents/Resources/bin/orca`. Puedes usar esa ruta completa o crear un
> alias: `alias orca=/Applications/Orca.app/Contents/Resources/bin/orca`.

### Qué permisos pide

| Permiso | Para qué |
| --- | --- |
| Correr código en Node con tu usuario (`trusted-worker`) | Ejecutar `ps` y `lsof`, leer `~/.claude/sessions/` y mandar las señales para cerrar procesos. |
| `storage:own` | Recordar qué procesos nacieron bajo cada sesión: es lo que delata a los huérfanos. |
| `settings:own` | Leer sus ajustes. |
| `notifications:show` | Avisarte cuando aparece un huérfano. |

No hace pedidos de red ni lee nada fuera de la lista de procesos y de `~/.claude/sessions/`.

### Actualizar o desinstalar

```sh
orca plugin update naitsric.claude-procesos      # pide aprobación de nuevo solo si cambian los permisos
orca plugin uninstall naitsric.claude-procesos
```

## Qué trae

- **Panel con dos pestañas.**
  - *Sesiones:* cada sesión con su nombre, su estado (trabajando o inactiva desde hace cuánto),
    su memoria y su árbol de procesos.
  - *Huérfanos:* lo que sobrevivió a su sesión.

  Al marcar filas ves el motivo de cada veredicto y la línea de comando completa.
- **Cerrar con confirmación en el lugar.** La pregunta aparece donde pulsaste y dice:
  - qué se cierra y cuánta memoria libera;
  - qué pasa: si la sesión está trabajando se corta la tarea, si cierras un MCP la sesión pierde
    esas herramientas;
  - con qué `claude --resume <id>` retomar la conversación.

  Usa SIGTERM y, si algo no responde, ofrece forzarlo con SIGKILL.
- **Barra de estado:** `Claude 5 · 2 huérfanos`, en amarillo o rojo si hay huérfanos ocupando
  puertos. Al pulsarla revisa en ese momento.
- **Paleta de comandos:** *Procesos de Claude: revisar ahora* y *cerrar los huérfanos seguros*.
- **Notificación** la primera vez que un proceso de Claude sobrevive a su sesión.

## Ajustes

En Settings → Plugins → Procesos de Claude:

| Ajuste | Por defecto | |
| --- | --- | --- |
| Cada cuántos segundos revisar | 15 | Entre 5 y 300. |
| Horas para marcar una sesión como larga | 12 | Una sesión inactiva más tiempo que esto queda en «revisar». |
| Avisar cuando aparezcan huérfanos | Sí | Notificación de escritorio. |

## Cómo decide

| Veredicto | Cuándo |
| --- | --- |
| **Cerrar** | Huérfanos seguros: su sesión de Claude terminó y nadie los usa. |
| **Revisar** | Sesiones inactivas más horas que las del ajuste. Comandos o servidores que llevan más de una hora en segundo plano. Procesos que se desprendieron de su sesión, por ejemplo un `nohup … &` lanzado desde Bash, que seguirán vivos cuando la cierres. Servidores MCP sueltos de origen dudoso. |
| **Dejar** | Lo que una sesión viva está usando: sus servidores MCP, `caffeinate` y los comandos en curso. |

Para saber qué es de Claude:

- **De una sesión:** cuelga, directa o indirectamente, de un proceso `claude`. El nombre, el id
  y el estado de cada sesión salen de `~/.claude/sessions/<pid>.json`, que Claude Code mantiene
  al día. Si no existe (versiones viejas), se usan la carpeta y el CPU.
- **Huérfano seguro:** cuelga de launchd y el plugin lo vio nacer bajo una sesión que ya terminó.
  También cuenta si conserva el grupo de procesos de esa sesión o de uno de sus shells, o si es
  un shell de la herramienta Bash (lleva la marca `~/.claude/shell-snapshots`).
- **Huérfano probable:** un servidor MCP suelto sin más pistas. Puede ser de otra app (Cursor,
  Claude Desktop), así que queda en «revisar».

macOS no deja leer las variables de entorno de otros procesos. Por eso la certeza viene de lo
que el plugin recuerda entre revisiones: grupos, linaje y las sesiones de los últimos 7 días. Lo
que murió **antes** de instalarlo solo se reconoce por sus marcas.

Antes de cerrar, el worker vuelve a revisar. Solo manda la señal a procesos que siguen en la foto
con la misma hora de inicio, así nunca mata un pid que el sistema le dio a otro proceso ni algo
que no sea de Claude. Tampoco toca procesos de otros usuarios.

## Limitaciones

- Solo probado en macOS. Usa `ps` y `/usr/sbin/lsof` de macOS.
- Cuenta sesiones de Claude Code en cualquier terminal (Orca, Ghostty, Terminal, iTerm2, VS
  Code…). El panel vive en Orca.

## Desarrollo

```sh
git clone https://github.com/naitsric/orca-claude-procesos
cd orca-claude-procesos
orca plugin dev load .              # pide aprobación igual que la instalación
orca plugin test .                  # pruebas de la lógica, el panel y el worker
npx -p typescript tsc -p .          # tipos (corre antes `orca plugin types .`)
orca plugin check .                 # pinta el panel con el worker real y con un caso inventado
```

Orca recarga el plugin cada vez que guardas un archivo y `orca plugin logs local.claude-procesos`
muestra lo que imprime el worker. No hay paso de compilación: Orca transpila el TypeScript al
cargarlo.

| Archivo | Qué hace |
| --- | --- |
| `src/procesos.ts` | Lógica pura: lee la salida de `ps` y `lsof`, agrupa por sesión, detecta huérfanos y da el veredicto. |
| `src/sistema.ts` | Corre `ps` y `lsof`, lee `~/.claude/sessions/` y manda las señales. |
| `src/worker.ts` | Revisa cada N segundos, guarda la memoria y actualiza el panel, la barra y las notificaciones. |
| `src/panel.tsx` | La interfaz. |
| `src/fixtures.ts` | Un sistema inventado para las pruebas y para `plugin check`. |

## Licencia

MIT
