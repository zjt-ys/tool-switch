/**
 * Tool Switch — per-conversation and global control over which tools the model
 * can call.
 *
 * Three callers share one implementation:
 *
 *   - the settings page (`/api/tool-switch/*`) owns the catalogue, the user's
 *     own groups, and the global default every conversation inherits;
 *   - the chat command (`/tool-switch ...`) and the session header control act
 *     on the current conversation;
 *   - the agent acts through the `tool_switch` tool, and through the plugin's
 *     own management tool.
 *
 * State is applied with `agent.ctx.tools.restrict({ deny })`, which hides those
 * tools from that agent's model-facing schema, lookup, and dispatch without
 * touching any other agent. Because a restricted tool cannot be called, a
 * conversation that switches this plugin's own tools off also loses the ability
 * to switch them back on — which is why the plugin's own tools are the last
 * thing `reset` and the global default restore.
 *
 * Durability comes from two places: the plugin's own documents under the
 * harness home hold the catalogue, the groups, and the global default; the
 * session log holds each conversation's own switch state, so a resumed,
 * forked, or reloaded conversation keeps it.
 */

import path from 'node:path'
import {
  DATA_DIR_NAME,
  DocumentWriter,
  STATE_VERSION,
  readDocument,
  resolveDshHome,
} from './store.js'
import {
  GROUP_SEPARATOR,
  USER_GROUP_PREFIX,
  autoGroupPath,
  buildTree,
  groupCovers,
  groupOf,
  groupPathOf,
} from './groups.js'

/** Stable Loader identity. */
export const name = '@local/tool-switch'

/** Services this plugin registers against. `systemPrompt` drives the hygiene policy. */
export const inject = ['tools', 'commands', 'agents', 'systemPrompt']

/** Slash command name; lowercase letters, digits, `_` and `-` only. */
const COMMAND_NAME = 'tool-switch'

/** Model-facing tool name for switching conversation tools. */
const TOOL_NAME = 'tool_switch'

/** Model-facing tool name for managing the catalogue and the groups. */
const MANAGE_TOOL_NAME = 'tool_switch_manage'

/**
 * Tools this plugin never hides: itself (hiding the switch would leave the
 * conversation unable to switch anything back on) and the reserved PTC transport.
 */
const NEVER_HIDE = new Set([TOOL_NAME, MANAGE_TOOL_NAME, 'run_code'])

const ACTIONS = ['list', 'all', 'groups', 'group', 'none', 'off', 'on', 'only', 'reset', 'apply-all']

const MANAGE_ACTIONS = ['catalog', 'group-create', 'group-edit', 'group-delete', 'group-move', 'global', 'policy']

/** Session id → disabled tool names. A derived cache of the session log. */
const states = new Map()

/** 提示词策略 section 在 registry 里的名字（全局唯一）。 */
const POLICY_SECTION = 'tool-switch:hygiene-policy'

/** 提示词策略的默认排序：策略段（500-900）之后、各工具说明（1000+）之前。 */
const POLICY_ORDER = 950

/** 默认点名的重型工具族：只进提示词文案，用户可在设置页改。 */
const DEFAULT_FAMILIES = [
  { group: 'mcp:rea', label: 'REA 逆向工程工具（200+ 个，最耗 token）' },
  { group: 'ig5', label: 'IG5 逆向工作台工具' },
]

/**
 * 规整提示词策略文档。字段缺失/类型不对时回默认值，绝不因旧文档缺字段而崩溃。
 * @param {unknown} raw - 磁盘或请求里的策略对象。
 * @returns a normalized policy record.
 */
function resolvePolicy(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const order = Number(source.order)
  const families =
    Array.isArray(source.families) && source.families.length > 0
      ? source.families
          .filter((row) => row !== null && typeof row === 'object' && typeof row.group === 'string' && row.group.trim() !== '')
          .map((row) => ({ group: row.group.trim(), label: typeof row.label === 'string' ? row.label : '' }))
      : DEFAULT_FAMILIES
  return {
    enabled: source.enabled !== false,
    order: Number.isFinite(order) && order >= -1000 && order <= 20000 ? Math.round(order) : POLICY_ORDER,
    extra: typeof source.extra === 'string' ? source.extra : '',
    text: typeof source.text === 'string' ? source.text : '',
    families,
  }
}

/**
 * 组装策略正文。`policy.text` 非空时整段替换；否则用内置策略 + families + extra。
 * @param {object} policy - 规整后的策略。
 * @returns {string} the section text.
 */
function renderPolicyText(policy) {
  if (typeof policy.text === 'string' && policy.text.trim() !== '') return policy.text
  const familyLines = policy.families
    .map((row) => `  - \`${row.group}\` —— ${row.label !== '' ? row.label : row.group}`)
  const extra = policy.extra.trim()
  return [
    '## 工具自检（每个任务开始前做一次）',
    '',
    '工具目录里的每个 schema 都常驻在上下文里，用不到的工具会一直消耗 token 和注意力。所以在接手一个任务、第一次调用工具之前，先花一步做工具自检：',
    '',
    `1. 先判断这个任务真正需要哪几类工具（文件读写、命令执行、搜索、网络、子代理、逆向分析……）。`,
    `2. 用 \`${TOOL_NAME}\`（\`action: "groups"\`）看一眼现有分组和开关状态。`,
    '3. 把**明确用不上**的整个工具族关掉：`action: "group"`、`group: "<组名>"`、`enabled: false`。按族关，不要一个一个关。',
    '4. 只关你有把握用不到的族。拿不准就留着——误关会让自己后面做不到事，比多花点 token 更糟。',
    '',
    familyLines.length === 0 ? '' : `当前这个部署里最典型的是：\n${familyLines.join('\n')}`,
    '',
    '任务中途真的需要某个已经关掉的族时，直接 `action: "group"` + `enabled: true` 打开再调用，不要因为工具不在列表里就断定做不到。',
    '',
    '约束：',
    '',
    '- 每个任务只做一次自检；不要每次回复前都重复一遍。工具集变了（装了插件、打开了新区）才重做。',
    `- \`${TOOL_NAME}\` 和 \`${MANAGE_TOOL_NAME}\` 本身永远不要关（关掉就再也打不开了；框架也不会真的隐藏它们）。`,
    '- 不要动 `core` 里的基础工具（read / write / edit / bash 或 pwsh 等），除非用户明确要求。',
    '- 用户明确说了要保留什么工具，就照用户说的做，不要自作主张。',
    '- 关掉工具之后，第一次用不到某工具时先想想是不是被自己关掉了，不要直接向用户宣称"做不到"。',
    extra === '' ? '' : `\n${extra}`,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Parse a slash-command raw input into the shared request shape.
 * @param {string} rawInput - the text after the command name.
 * @returns the request the evaluator understands.
 */
function parseRawInput(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return { action: 'list' }
  const action = tokens[0].toLowerCase()
  if (action === 'group') {
    return {
      action,
      group: tokens.length > 1 ? tokens[1].toLowerCase() : '',
      enabled: tokens.length > 2 ? tokens[2].toLowerCase() !== 'off' : true,
    }
  }
  return { action, names: tokens.slice(1) }
}

/**
 * Host half of the tool switch.
 * @param {object} ctx - plugin context.
 */
export function apply(ctx) {
  const logger = ctx.logger ?? console
  const home = resolveDshHome()
  const dataDir = path.resolve(home, DATA_DIR_NAME)
  const catalogFile = path.resolve(dataDir, 'tools.json')
  const groupsFile = path.resolve(dataDir, 'groups.json')
  const stateFile = path.resolve(dataDir, 'state.json')
  const policyFile = path.resolve(dataDir, 'policy.json')

  /** The user's own groups, by id. */
  let groups = readDocument(groupsFile, { version: STATE_VERSION, groups: {} }).groups ?? {}
  /** The written-down tool catalogue. */
  let catalog = readDocument(catalogFile, { version: STATE_VERSION, tools: [] })
  /** The persisted global default. */
  const persisted = readDocument(stateFile, { version: STATE_VERSION, disabled: [] })
  /** 提示词策略（工具自检）的持久化文档。 */
  let policy = resolvePolicy(readDocument(policyFile, { version: STATE_VERSION }))

  /** Global default every new conversation inherits. */
  let globalDefault = new Set(
    (persisted.disabled ?? []).filter((toolName) => typeof toolName === 'string'),
  )

  const globalWriter = new DocumentWriter(stateFile, () => ({
    version: STATE_VERSION,
    disabled: [...globalDefault].sort(),
  }))
  const groupsWriter = new DocumentWriter(groupsFile, () => ({
    version: STATE_VERSION,
    groups,
  }))
  const catalogWriter = new DocumentWriter(catalogFile, () => catalog)
  const policyWriter = new DocumentWriter(policyFile, () => ({ version: STATE_VERSION, ...policy }))

  /** agent → restriction disposer currently registered on its scope. */
  const restrictions = new Map()

  /** The agents that are live right now. */
  const liveAgents = () => {
    try {
      return ctx.agents?.list?.() ?? []
    } catch {
      return []
    }
  }

  /** Tool names a conversation may switch (the global, restrictable view). */
  const switchableNames = () => {
    let schemas = []
    try {
      schemas = ctx.tools.schemas()
    } catch {
      schemas = []
    }
    return schemas
      .map((schema) => schema.name)
      .filter((toolName) => !NEVER_HIDE.has(toolName))
      .sort()
  }

  /** Every registered tool name, including this plugin's own. */
  const allToolNames = () => {
    let schemas = []
    try {
      schemas = ctx.tools.schemas()
    } catch {
      schemas = []
    }
    return schemas.map((schema) => schema.name).sort()
  }

  const disabledOf = (agent) => states.get(agent.id) ?? new Set()

  /** Re-apply one agent's switch state, replacing its previous restriction. */
  const refreshAgent = (agent) => {
    const previous = restrictions.get(agent)
    if (previous !== undefined) {
      restrictions.delete(agent)
      try {
        previous()
      } catch {
        // A restriction already disposed with its agent scope is not an error.
      }
    }
    const known = new Set(switchableNames())
    const deny = [...disabledOf(agent)].filter((toolName) => known.has(toolName))
    if (deny.length === 0) return
    try {
      restrictions.set(agent, agent.ctx.tools.restrict({ deny }))
    } catch (error) {
      logger.warn?.(`tool-switch: could not restrict tools for ${agent.id}: ${String(error)}`)
    }
  }

  /** One catalogue row for one tool. */
  const catalogueRow = (toolName) => {
    const path = groupPathOf(groupOf(toolName, groups), groups)
    const automatic = autoGroupPath(toolName)
    return {
      name: toolName,
      group: path[path.length - 1],
      groupPath: path,
      autoGroup: automatic[automatic.length - 1],
      autoGroupPath: automatic,
      switchable: !NEVER_HIDE.has(toolName),
    }
  }

  /** The classification tree, as plain data. */
  const treeData = () => {
    const tree = buildTree(allToolNames(), groups)
    return {
      roots: tree.roots,
      nodes: [...tree.nodes.values()].map((node) => ({
        id: node.id,
        depth: node.depth,
        user: node.user,
        count: node.members.length,
        children: node.children,
        members: node.members,
        direct: node.direct,
      })),
    }
  }

  /** Write the catalogue document, so the AI and the page read one file. */
  const publishCatalog = () => {
    const names = allToolNames()
    catalog = {
      version: STATE_VERSION,
      updatedAt: Date.now(),
      tools: names.map(catalogueRow),
      groups: treeData().nodes,
      userGroups: groups,
      global: {
        disabled: [...globalDefault].sort(),
        enabled: switchableNames().filter((toolName) => !globalDefault.has(toolName)),
      },
    }
    catalogWriter.schedule()
    return catalog
  }

  /**
   * Render the classification tree with per-group counts.
   * @param {string[]} restrictable - switchable tool names.
   * @param {Set<string>} disabled - disabled tool names.
   * @returns one line per group, nested groups indented.
   */
  const renderGroups = (restrictable, disabled) => {
    const tree = buildTree(restrictable, groups)
    const lines = [`Groups (${tree.nodes.size}), switchable (${restrictable.length}), disabled (${disabled.size})`]
    const ordered = [...tree.nodes.values()].sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth
      return left.id < right.id ? -1 : 1
    })
    for (const node of ordered) {
      const off = node.members.filter((toolName) => disabled.has(toolName)).length
      const pad = '  '.repeat(node.depth)
      lines.push(`${pad}${node.id}  ${node.members.length - off}/${node.members.length}`)
    }
    return lines.join('\n')
  }

  /**
   * Execute one switch operation for one conversation.
   * @param {object} agent - the receiving agent.
   * @param {object} request - parsed action, tool names, and optional group target.
   * @returns a normalized outcome; `ok` is false for a refused request.
   */
  const evaluate = (agent, request) => {
    const action = request.action
    const names = Array.isArray(request.names) ? request.names : []
    const restrictable = switchableNames()
    const known = new Set(restrictable)
    const disabled = new Set(disabledOf(agent))

    const summarize = () => {
      const off = [...disabled].filter((toolName) => known.has(toolName)).sort()
      if (restrictable.length === 0) return 'No switchable tools are registered.'
      if (off.length === 0) return `All ${restrictable.length} switchable tools are enabled.`
      return `${off.length} of ${restrictable.length} switchable tools are disabled: ${off.join(', ')}`
    }

    const commit = () => {
      if (disabled.size === 0) states.delete(agent.id)
      else states.set(agent.id, new Set(disabled))
      refreshAgent(agent)
    }

    if (action === 'list') return { ok: true, message: summarize() }
    if (action === 'groups') return { ok: true, message: renderGroups(restrictable, disabled) }

    if (action === 'all') {
      const off = restrictable.filter((toolName) => disabled.has(toolName)).sort()
      const on = restrictable.filter((toolName) => !disabled.has(toolName)).sort()
      return {
        ok: true,
        message: [
          `Enabled (${on.length}): ${on.length === 0 ? '—' : on.join(', ')}`,
          `Disabled (${off.length}): ${off.length === 0 ? '—' : off.join(', ')}`,
        ].join('\n'),
      }
    }

    if (action === 'group') {
      const groupId = typeof request.group === 'string' ? request.group.trim().toLowerCase() : ''
      if (groupId.length === 0) {
        return { ok: false, message: `usage: /${COMMAND_NAME} group <group-id> <on|off>` }
      }
      const members = restrictable.filter((toolName) => groupCovers(groupId, toolName, groups))
      if (members.length === 0) {
        return {
          ok: false,
          message: `Unknown group "${groupId}". Run /${COMMAND_NAME} groups to list groups.`,
        }
      }
      const enable = request.enabled !== false
      for (const toolName of members) {
        if (enable) disabled.delete(toolName)
        else disabled.add(toolName)
      }
      commit()
      return {
        ok: true,
        message: `${enable ? 'Enabled' : 'Disabled'} group "${groupId}" (${members.length} tools). ${summarize()}`,
      }
    }

    if (action === 'none') {
      for (const toolName of restrictable) disabled.add(toolName)
      commit()
      return { ok: true, message: `Disabled all ${restrictable.length} switchable tools.` }
    }

    if (action === 'apply-all') {
      let applied = 0
      for (const other of liveAgents()) {
        if (other.id === agent.id) continue
        if (disabled.size === 0) states.delete(other.id)
        else states.set(other.id, new Set(disabled))
        refreshAgent(other)
        applied += 1
      }
      globalDefault = new Set(disabled)
      globalWriter.schedule()
      publishCatalog()
      return {
        ok: true,
        message: `Applied to ${applied} other conversation(s); new conversations inherit it. ${summarize()}`,
      }
    }

    if (action === 'off' || action === 'on' || action === 'only') {
      if (names.length === 0) {
        return { ok: false, message: `usage: /${COMMAND_NAME} ${action} <tool-name> [...]` }
      }
      const unknown = names.filter((toolName) => !known.has(toolName))
      if (unknown.length > 0) {
        return {
          ok: false,
          message: `Unknown or non-switchable tool(s): ${unknown.join(', ')}. Run /${COMMAND_NAME} all to list the switchable tools.`,
        }
      }
      if (action === 'off') {
        for (const toolName of names) disabled.add(toolName)
      } else if (action === 'on') {
        for (const toolName of names) disabled.delete(toolName)
      } else {
        disabled.clear()
        const keep = new Set(names)
        for (const toolName of restrictable) if (!keep.has(toolName)) disabled.add(toolName)
      }
    } else if (action === 'reset') {
      disabled.clear()
    } else {
      return {
        ok: false,
        message: `Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}.`,
      }
    }

    commit()
    return { ok: true, message: summarize() }
  }

  /**
   * Rebuild one agent's switch state from its durable session log.
   * @param {object} agent - the agent being created.
   */
  const adoptAgent = (agent) => {
    const session = agent.session
    if (session === undefined || typeof session.ownEvents !== 'function') return
    const known = switchableNames()
    const disabled = new Set(globalDefault)
    for (const event of session.ownEvents()) {
      try {
        if (event.type === 'command/run' && event.data?.name === COMMAND_NAME) {
          const request = parseRawInput(event.data.args)
          applyRecord(disabled, known, request)
        } else if (event.type === 'tool/call' && event.data?.name === TOOL_NAME) {
          const args = JSON.parse(event.data.arguments)
          applyRecord(disabled, known, {
            action: typeof args?.action === 'string' ? args.action : 'list',
            names: Array.isArray(args?.tools) ? args.tools.map(String) : [],
            group: typeof args?.group === 'string' ? args.group : '',
            enabled: args?.enabled !== false,
          })
        }
      } catch {
        // A malformed historical record must not block the conversation.
      }
    }
    // Historical commands may name tools that are no longer switchable.
    for (const toolName of [...disabled]) {
      if (!known.has(toolName)) disabled.delete(toolName)
    }
    if (disabled.size === 0) states.delete(agent.id)
    else states.set(agent.id, new Set(disabled))
    refreshAgent(agent)
  }

  /**
   * Apply one recorded switch operation to a disabled-name set.
   * @param {Set<string>} disabled - the set to mutate.
   * @param {Set<string>} known - switchable tool names.
   * @param {object} request - the recorded operation.
   */
  const applyRecord = (disabled, known, request) => {
    if (request.action === 'group') {
      const members = [...known].filter((toolName) => groupCovers(request.group, toolName, groups))
      for (const toolName of members) {
        if (request.enabled === false) disabled.add(toolName)
        else disabled.delete(toolName)
      }
      return
    }
    if (request.action === 'none') {
      for (const toolName of known) disabled.add(toolName)
      return
    }
    if (request.action === 'off') {
      for (const toolName of request.names ?? []) disabled.add(toolName)
      return
    }
    if (request.action === 'on') {
      for (const toolName of request.names ?? []) disabled.delete(toolName)
      return
    }
    if (request.action === 'only') {
      disabled.clear()
      const keep = new Set(request.names ?? [])
      for (const toolName of known) if (!keep.has(toolName)) disabled.add(toolName)
      return
    }
    if (request.action === 'reset') disabled.clear()
  }

  // ── the management surface the settings page and the AI share ──────────────

  /** The full catalogue, groups, global state, and the hygiene policy, as the page reads it. */
  const snapshot = () => ({
    version: STATE_VERSION,
    tools: allToolNames().map(catalogueRow),
    groups: treeData().nodes,
    roots: treeData().roots,
    userGroups: groups,
    policy,
    policyText: renderPolicyText(policy),
    global: {
      disabled: [...globalDefault].sort(),
      enabled: switchableNames().filter((toolName) => !globalDefault.has(toolName)),
    },
  })

  /**
   * Apply one management request from the page or the AI.
   * @param {object} request - the management request.
   * @returns a normalized outcome.
   */
  const manage = (request) => {
    const action = request.action
    if (action === 'catalog') {
      publishCatalog()
      return { ok: true, message: `Catalogue refreshed: ${allToolNames().length} tools.` }
    }
    if (action === 'group-create') {
      const label = String(request.label ?? '').trim()
      if (label.length === 0) return { ok: false, message: 'A group needs a label.' }
      const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
      if (slug.length === 0) return { ok: false, message: 'That label produces an empty group id.' }
      const id = `${USER_GROUP_PREFIX}${slug}`
      const parent =
        typeof request.parent === 'string' && request.parent.length > 0 ? request.parent.toLowerCase() : undefined
      groups = {
        ...groups,
        [id]: { label, parent, tools: Array.isArray(request.tools) ? request.tools.map(String) : [] },
      }
      groupsWriter.schedule()
      publishCatalog()
      return { ok: true, message: `Created group "${label}" (${id}).` }
    }
    if (action === 'group-edit') {
      const id = String(request.id ?? '').trim().toLowerCase()
      if (groups[id] === undefined) return { ok: false, message: `Unknown group "${id}".` }
      const next = { ...groups[id] }
      if (typeof request.label === 'string' && request.label.trim().length > 0) next.label = request.label.trim()
      if (typeof request.parent === 'string') {
        const parent = request.parent.trim().toLowerCase()
        next.parent = parent.length === 0 ? undefined : parent
      }
      if (Array.isArray(request.tools)) next.tools = request.tools.map(String)
      groups = { ...groups, [id]: next }
      groupsWriter.schedule()
      publishCatalog()
      return { ok: true, message: `Updated group "${id}".` }
    }
    if (action === 'group-delete') {
      const id = String(request.id ?? '').trim().toLowerCase()
      if (groups[id] === undefined) return { ok: false, message: `Unknown group "${id}".` }
      const next = { ...groups }
      delete next[id]
      groups = next
      groupsWriter.schedule()
      publishCatalog()
      return { ok: true, message: `Deleted group "${id}".` }
    }
    if (action === 'group-move') {
      const id = String(String(request.id ?? '').trim().toLowerCase())
      if (groups[id] === undefined) return { ok: false, message: `Unknown group "${id}".` }
      const parent = String(request.parent ?? '').trim().toLowerCase()
      groups = { ...groups, [id]: { ...groups[id], parent: parent.length === 0 ? undefined : parent } }
      groupsWriter.schedule()
      publishCatalog()
      return { ok: true, message: `Moved group "${id}".` }
    }
    if (action === 'global') {
      const disabled = Array.isArray(request.disabled) ? request.disabled.map(String) : []
      globalDefault = new Set(disabled)
      globalWriter.schedule()
      for (const agent of liveAgents()) {
        if (states.has(agent.id)) continue
        if (globalDefault.size === 0) states.delete(agent.id)
        else states.set(agent.id, new Set(globalDefault))
        refreshAgent(agent)
      }
      publishCatalog()
      return { ok: true, message: `Global default: ${globalDefault.size} tool(s) disabled.` }
    }
    if (action === 'policy') {
      // 设置页与 AI 共用的策略编辑口：给 policy 就整段替换，给字段就部分更新。
      if (request.policy !== undefined) {
        policy = resolvePolicy({ ...policy, ...(request.policy !== null && typeof request.policy === 'object' ? request.policy : {}) })
      } else {
        policy = resolvePolicy({
          ...policy,
          ...(request.enabled === undefined ? {} : { enabled: request.enabled === true }),
          ...(request.order === undefined ? {} : { order: Number(request.order) }),
          ...(request.extra === undefined ? {} : { extra: String(request.extra ?? '') }),
          ...(request.text === undefined ? {} : { text: String(request.text ?? '') }),
          ...(request.families === undefined ? {} : { families: request.families }),
        })
      }
      policyWriter.schedule()
      return { ok: true, message: `Policy ${policy.enabled ? 'enabled' : 'disabled'}; ${policy.families.length} family(ies) named.`, state: snapshot() }
    }
    return { ok: false, message: `Unknown management action "${action}".` }
  }

  // ── registrations ─────────────────────────────────────────────────────────

  // 提示词策略：一个全局 section，让模型接手任务时先做工具自检。
  // text 是闭包，策略在设置页/AI 改完的下一次组装就生效；按 agent 查一次
  // tool_switch 可见性，不可见就不注入（避免模型去调不存在的工具）。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: POLICY_SECTION,
        order: policy.order,
        // 用户可能在 extra 里写 `{{...}}`；关掉插值，避免把一次请求搞崩。
        interpolate: false,
        text: (context) => {
          if (!policy.enabled) return ''
          try {
            const agent = context?.agent
            const visible = agent === undefined ? ctx.tools.get(TOOL_NAME) : ctx.tools.get(TOOL_NAME, agent)
            if (visible === undefined) return ''
          } catch {
            return ''
          }
          return renderPolicyText(policy)
        },
      }),
    'tool-switch: hygiene-policy section',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: COMMAND_NAME,
        description: 'Turn tools or tool groups on or off for this conversation.',
        input: {
          hint: '[list|groups|all|group <id> <on|off>|off|on|only <tool...>|none|reset|apply-all]',
        },
        handler: ({ agent, rawInput }) => {
          const request = parseRawInput(rawInput)
          const outcome = evaluate(agent, request)
          return outcome.ok
            ? { kind: 'success', text: outcome.message }
            : { kind: 'error', text: outcome.message }
        },
      }),
    'tool-switch: /tool-switch command',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_NAME,
        description:
          'Turn individual tools or whole tool groups on or off for this conversation. A disabled ' +
          'tool disappears from your tool list and cannot be called until it is turned back on, ' +
          'which keeps unneeded tool schemas out of the context. The user controls the same switch ' +
          'through the /tool-switch command and the Tool Switch settings page, so changes made ' +
          'here are visible to them and survive resume. Tools are classified by name, such as ' +
          '"mcp:rea" with nested groups like "mcp:rea/inspect", plus "core" for ungrouped names. ' +
          'Actions: "list" reports a summary, "groups" lists the classification tree, "all" lists ' +
          'every switchable tool name, "group" switches one group including its nested groups, ' +
          '"off" disables named tools, "on" enables them, "only" disables everything except the ' +
          'named tools, "none" disables every switchable tool, "reset" enables everything, and ' +
          '"apply-all" copies this conversation\'s switch state to every other conversation and ' +
          'to new ones.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ACTIONS,
              description: 'list/groups/all read the switch; group/off/on/only/none/reset change it.',
            },
            tools: {
              type: 'array',
              description: 'Exact tool names, required by off, on and only.',
              items: { type: 'string' },
            },
            group: {
              type: 'string',
              description: 'Group id from the "groups" tree, required by the group action.',
            },
            enabled: {
              type: 'boolean',
              description: 'Group action target: true enables the group, false disables it.',
            },
          },
          required: ['action'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', description: 'False when the request was refused.' },
              message: { type: 'string', description: 'Human-readable switch state or refusal reason.' },
            },
            required: ['ok', 'message'],
          },
          render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        execute: async (args, exec) => {
          const agent = exec.agent
          if (agent === undefined) {
            return { ok: false, message: `${TOOL_NAME} requires an agent conversation.` }
          }
          const action = typeof args?.action === 'string' ? args.action : 'list'
          const names = Array.isArray(args?.tools) ? args.tools.map(String) : []
          return evaluate(agent, {
            action,
            names,
            group: typeof args?.group === 'string' ? args.group : '',
            enabled: args?.enabled !== false,
          })
        },
      }),
    'tool-switch: tool_switch tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: MANAGE_TOOL_NAME,
        description:
          'Manage the tool switch catalogue and the user\'s own tool groups, and set the global ' +
          'default every conversation inherits. Use it to create a group, move tools into it, ' +
          'rename or delete it, or to turn tools off for every conversation at once. The catalogue ' +
          'and the groups are also written to a JSON document the user can read and edit. ' +
          'Actions: "catalog" refreshes the written catalogue, "group-create" creates a user ' +
          'group, "group-edit" changes a group\'s label, parent or members, "group-delete" removes ' +
          'a group, "group-move" re-parents a group, and "global" sets the default switch state ' +
          'every new conversation inherits.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: MANAGE_ACTIONS,
              description: 'Which management operation to run.',
            },
            id: {
              type: 'string',
              description: 'Group id, required by group-edit, group-delete and group-move.',
            },
            label: { type: 'string', description: 'Human-readable group label.' },
            parent: { type: 'string', description: 'Parent group id; empty makes the group a root.' },
            tools: {
              type: 'array',
              description: 'Tool names the group owns.',
              items: { type: 'string' },
            },
            disabled: {
              type: 'array',
              description: 'Tool names disabled by the global default.',
              items: { type: 'string' },
            },
          },
          required: ['action'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', description: 'False when the request was refused.' },
              message: { type: 'string', description: 'Human-readable result or refusal reason.' },
            },
            required: ['ok', 'message'],
          },
          render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        execute: async (args) =>
          manage({
            action: typeof args?.action === 'string' ? args.action : 'catalog',
            id: typeof args?.id === 'string' ? args.id : '',
            label: typeof args?.label === 'string' ? args.label : '',
            parent: typeof args?.parent === 'string' ? args.parent : '',
            tools: Array.isArray(args?.tools) ? args.tools.map(String) : undefined,
            disabled: Array.isArray(args?.disabled) ? args.disabled.map(String) : undefined,
          }),
      }),
    'tool-switch: tool_switch_manage tool',
  )

  // ── the settings page's HTTP surface ──────────────────────────────────────

  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    scoped.effect(
      () =>
        server.register({
          kind: 'prefix',
          path: '/api/tool-switch',
          handler: async (req, res) => {
            const send = (status, payload) => {
              res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              res.end(JSON.stringify(payload))
            }
            const url = new URL(req.url ?? '/', 'http://localhost')
            const route = url.pathname.replace(/^\/api\/tool-switch/u, '').replace(/\/+$/u, '') || '/'
            const method = String(req.method ?? 'GET').toUpperCase()
            try {
              if (method === 'GET' && (route === '/' || route === '/state')) {
                return send(200, snapshot())
              }
              if (method === 'GET' && route === '/catalog') {
                return send(200, publishCatalog())
              }
              if (method === 'POST' && route === '/manage') {
                const chunks = []
                for await (const chunk of req) chunks.push(chunk)
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
                const outcome = manage(body)
                return send(outcome.ok ? 200 : 400, { ...outcome, state: snapshot() })
              }
              return send(404, { error: 'not found' })
            } catch (error) {
              return send(500, { error: String(error) })
            }
          },
        }),
      'tool-switch: api routes',
    )
    logger.info?.('tool-switch: settings API mounted at /api/tool-switch')
  })

  ctx.on('agent/created', ({ agent }) => {
    try {
      adoptAgent(agent)
    } catch (error) {
      logger.warn?.(`tool-switch: could not restore switches for ${agent.id}: ${String(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent.id)
    const dispose = restrictions.get(agent)
    if (dispose === undefined) return
    restrictions.delete(agent)
    try {
      dispose()
    } catch {
      // The agent scope may already be unwinding; nothing left to lift.
    }
  })

  ctx.on('session/disposed', (session) => {
    states.delete(session.id)
  })

  ctx.effect(
    () => () => {
      for (const dispose of restrictions.values()) {
        try {
          dispose()
        } catch {
          // Unloading: a throwing disposer only skips this entry.
        }
      }
      restrictions.clear()
      states.clear()
      globalWriter.dispose()
      groupsWriter.dispose()
      catalogWriter.dispose()
      policyWriter.dispose()
    },
    'tool-switch: cleanup',
  )

  // Publish the catalogue once the tool registry has settled.
  publishCatalog()
  setTimeout(() => publishCatalog(), 2000).unref?.()

  // Adopt agents that were already live when this plugin loaded.
  for (const agent of liveAgents()) {
    try {
      adoptAgent(agent)
    } catch (error) {
      logger.warn?.(`tool-switch: could not adopt ${agent.id}: ${String(error)}`)
    }
  }
}

export { GROUP_SEPARATOR, USER_GROUP_PREFIX, autoGroupPath, buildTree, groupCovers, groupOf, groupPathOf }
