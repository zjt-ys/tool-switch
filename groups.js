/**
 * Tool Switch — classification.
 *
 * Two layers decide which group a tool belongs to:
 *
 *   1. the automatic layer derives a group path from the tool's name, so a
 *      freshly installed tool is classified without any configuration;
 *   2. the user's layer assigns a tool to a group of their own, which wins.
 *
 * A user's group may nest inside another user's group, and a user group may
 * also hold automatic members by naming an automatic group as its parent. The
 * resulting tree is what both the settings page and the AI read.
 */

/** Separator between a group and its child in a group id. */
export const GROUP_SEPARATOR = '/'

/** Prefix that marks a group id as user-defined. */
export const USER_GROUP_PREFIX = 'u:'

/**
 * Derive the automatic group path of one tool name.
 *
 * `mcp__server__name` becomes `mcp:server` plus a second level for the tool's
 * leading word, so the REA catalogue lands in one family with readable
 * subgroups. Every other name groups by its first `_`-separated segment, and a
 * name without a separator lands in `core`.
 *
 * @param {string} toolName - registered tool name.
 * @returns the automatic group path, outer-most first.
 */
export function autoGroupPath(toolName) {
  const mcp = /^mcp__([A-Za-z0-9]+)__(.+)$/u.exec(toolName)
  if (mcp !== null) {
    const family = `mcp:${mcp[1]}`
    const head = /^[A-Za-z]+/u.exec(mcp[2])
    return head === null ? [family] : [family, `${family}${GROUP_SEPARATOR}${head[0].toLowerCase()}`]
  }
  const parts = toolName.split('_')
  return parts.length > 1 ? [parts[0]] : ['core']
}

/**
 * The automatic group id that directly contains one tool.
 * @param {string} toolName - registered tool name.
 * @returns the innermost automatic group id.
 */
export function autoGroupOf(toolName) {
  const path = autoGroupPath(toolName)
  return path[path.length - 1]
}

/**
 * Whether one group id covers a tool, including through nesting.
 * @param {string} groupId - group id to test.
 * @param {string} toolName - registered tool name.
 * @returns true when the group owns the tool.
 */
export function groupCovers(groupId, toolName, groups) {
  if (groupId.length === 0) return false
  const path = groupPathOf(groupId, groups)
  const automatic = autoGroupPath(toolName)
  for (const id of path) {
    if (automatic.includes(id)) return true
  }
  // A user group may also carry explicit tool members.
  const group = groups[groupId]
  if (group !== undefined && Array.isArray(group.tools) && group.tools.includes(toolName)) return true
  return false
}

/**
 * The full path of one group, from its outermost ancestor to itself.
 * @param {string} groupId - group id.
 * @param {Record<string, {parent?: string}>} groups - user groups by id.
 * @returns the ancestor ids, outer-most first.
 */
export function groupPathOf(groupId, groups) {
  const path = []
  let current = groupId
  const guard = new Set()
  while (current !== undefined && current !== '' && !guard.has(current)) {
    guard.add(current)
    path.unshift(current)
    const group = groups[current]
    current = group === undefined ? undefined : group.parent
  }
  return path
}

/**
 * The group a tool belongs to, honouring the user's assignment first.
 * @param {string} toolName - registered tool name.
 * @param {Record<string, {parent?: string, tools?: string[]}>} groups - user groups.
 * @returns the owning group id.
 */
export function groupOf(toolName, groups) {
  for (const [id, group] of Object.entries(groups)) {
    if (Array.isArray(group.tools) && group.tools.includes(toolName)) {
      const path = groupPathOf(id, groups)
      return path[path.length - 1]
    }
  }
  return autoGroupOf(toolName)
}

/**
 * Build the classification tree over a set of tool names.
 *
 * @param {string[]} toolNames - every switchable tool name.
 * @param {Record<string, {parent?: string, tools?: string[], label?: string}>} groups - user groups.
 * @returns the tree nodes keyed by group id, each with its members and children.
 */
export function buildTree(toolNames, groups) {
  const nodes = new Map()
  const ensure = (id, depth) => {
    let node = nodes.get(id)
    if (node === undefined) {
      node = { id, depth, members: [], direct: [], children: [], user: id.startsWith(USER_GROUP_PREFIX) }
      nodes.set(id, node)
    }
    return node
  }

  // User groups first: their own nesting is authoritative.
  for (const [id, group] of Object.entries(groups)) {
    const path = groupPathOf(id, groups)
    for (let depth = 0; depth < path.length; depth++) {
      const node = ensure(path[depth], depth)
      if (depth > 0) {
        const parent = ensure(path[depth - 1], depth - 1)
        if (!parent.children.includes(path[depth])) parent.children.push(path[depth])
      }
    }
    void group
  }

  for (const toolName of toolNames) {
    const owner = groupOf(toolName, groups)
    const ownerPath = groupPathOf(owner, groups)
    // A user group may sit under an automatic family; keep the family visible.
    const automatic = autoGroupPath(toolName)
    const full = [...automatic.slice(0, automatic.length - 1)]
    for (const id of ownerPath) {
      if (full.includes(id)) continue
      full.push(id)
    }
    for (let depth = 0; depth < full.length; depth++) {
      const id = full[depth]
      const node = ensure(id, depth)
      if (depth === full.length - 1) {
        if (!node.members.includes(toolName)) node.members.push(toolName)
      } else {
        const parent = ensure(full[depth], depth)
        void parent
      }
      if (depth > 0) {
        const parent = ensure(full[depth - 1], depth - 1)
        if (!parent.children.includes(id)) parent.children.push(id)
      }
    }
  }

  // Aggregate members upward: a parent group covers everything beneath it, so a
  // family such as `mcp:rea` is not empty merely because its tools sit in
  // `mcp:rea/inspect` and its siblings. `direct` keeps the group's own members.
  for (const node of nodes.values()) {
    node.direct = node.members.slice()
  }
  const ordered = [...nodes.values()].sort((left, right) => right.depth - left.depth)
  for (const node of ordered) {
    for (const childId of node.children) {
      const child = nodes.get(childId)
      if (child === undefined) continue
      for (const toolName of child.members) {
        if (!node.members.includes(toolName)) node.members.push(toolName)
      }
    }
  }
  for (const node of nodes.values()) node.members.sort()

  const roots = []
  for (const node of nodes.values()) {
    node.children.sort()
    if (node.depth === 0) roots.push(node.id)
  }
  roots.sort()
  return { nodes, roots }
}
