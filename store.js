/**
 * Tool Switch — durable state.
 *
 * The plugin owns three durable artefacts under the harness home:
 *
 *   tools.json     the full tool inventory with its classification, so the AI
 *                  and the settings page read one written-down catalogue
 *   groups.json    the user's own groups and their members, layered over the
 *                  automatic name-derived classification
 *   state.json     the global default switch state, which every conversation
 *                  inherits
 *
 * A plain JSON file per artefact is used rather than a harness storage service
 * because the tool-switch domain has to work in a bare profile that mounts no
 * storage rows, and because a plugin-owned file survives profile upgrades.
 * Writes land through a temp file and a rename, so a crash mid-write cannot
 * leave a truncated document.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Same resolution the harness home-paths helper uses: `$DSH_HOME` else `~/.dsh`. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** Directory under the harness home that holds this plugin's documents. */
export const DATA_DIR_NAME = 'tool-switch'

/** Bumped when the shape or the meaning of a stored field changes. */
export const STATE_VERSION = 1

/**
 * Read one JSON document, tolerating absence and corruption.
 * @param {string} file - absolute path.
 * @param {object} initial - value used when the file is missing or unusable.
 * @returns the stored value merged over the initial value.
 */
export function readDocument(file, initial) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...initial, ...parsed }
    }
  } catch {
    // A missing or damaged document falls back to the initial value.
  }
  return { ...initial }
}

/**
 * Write one JSON document atomically.
 * @param {string} file - absolute path.
 * @param {object} value - the document to store.
 */
export function writeDocument(file, value) {
  const temp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

/**
 * A coalescing writer: many mutations in one tick cost one disk write.
 */
export class DocumentWriter {
  /**
   * @param {string} file - absolute path.
   * @param {() => object} produce - the document producer, called on each flush.
   */
  constructor(file, produce) {
    this.file = file
    this.produce = produce
    this.timer = undefined
    this.disposed = false
  }

  /** Schedule a write; repeated calls within a tick collapse into one. */
  schedule() {
    if (this.disposed) return
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 50)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Write the document now. */
  flush() {
    if (this.disposed) return
    try {
      writeDocument(this.file, this.produce())
    } catch (error) {
      // A failed write keeps the in-memory value; the next schedule retries.
      console.warn(`tool-switch: could not write ${this.file}: ${String(error)}`)
    }
  }

  /** Cancel a pending write and flush once more. */
  dispose() {
    if (this.disposed) return
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flush()
    this.disposed = true
  }
}
