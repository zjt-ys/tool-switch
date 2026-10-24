/**
 * Tool Switch — Client half.
 *
 * Contributes two things to the web shell:
 *
 *   1. a settings page (`settings.section`) that owns the whole tool catalogue:
 *      the classification tree, the user's own groups with editing, the global
 *      default every conversation inherits, and the per-conversation switch;
 *   2. a compact control in the Session header utilities, so a conversation can
 *      be switched without leaving the transcript.
 *
 * The page talks to the plugin's Host half over its own same-origin
 * `/api/tool-switch/*` routes, because an installed browser bundle has no
 * package-private Host channel. The per-conversation switch still travels
 * through the Session's command plane, so the page, the chat command, and the
 * agent share one implementation.
 */
window.__ModuleLoader__.load({
  id: '@local/tool-switch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'tool-switch';
    const CMD = 'tool-switch';
    const API = '/api/tool-switch';

    const en = {
      nav: 'Tool Switch',
      title: 'Tool Switch',
      intro:
        'Choose which tools a conversation can call. Disabled tools leave the model\'s tool list, ' +
        'so unused schemas stop consuming context. The global default applies to every new ' +
        'conversation; each conversation may differ.',
      load: 'Load',
      reload: 'Refresh',
      loading: 'Loading…',
      failed: 'Could not reach the tool switch service: {reason}',
      saved: 'Saved.',
      global: 'Global default',
      globalHint: 'Every new conversation starts with these tools disabled.',
      groups: 'Groups',
      groupsHint:
        'Tools are classified by name. Create your own groups to organise them; a group switch ' +
        'covers everything inside it.',
      newGroup: 'New group',
      groupName: 'Group name',
      parent: 'Parent group',
      noParent: 'No parent',
      create: 'Create',
      save: 'Save',
      cancel: 'Cancel',
      delete: 'Delete',
      rename: 'Rename',
      members: 'Members',
      search: 'Filter tools',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      enableAll: 'Enable all',
      disableAll: 'Disable all',
      applyToAll: 'Apply to all conversations',
      conversation: 'This conversation',
      empty: 'Nothing matches.',
      on: '{on}/{total}',
      off: '{n} off',
      allOn: 'all on',
      catalogue: 'Written catalogue',
      catalogueHint:
        'Every tool, its group, and the global default are written to a JSON document under the ' +
        'harness home, so the agent and the user read the same catalogue.',
      policy: 'Prompt policy',
      policyHint:
        'Injects a system-prompt section that tells the agent to inspect the tool catalogue first ' +
        'and switch off families this task does not need. The section renders only when the ' +
        'switch tool itself is callable.',
      policyEnabled: 'Inject the tool-hygiene policy',
      policyExtra: 'Extra instructions appended to the policy',
      policyExtraPlaceholder: 'e.g. This project is pure frontend; never open the reverse-engineering families.',
      policyPreview: 'Injected text',
      policyPreviewHint: 'What the next request receives (empty while the switch tool is unavailable).',
      policySave: 'Save policy',
      policySaved: 'Policy saved.',
      policyFamilies: 'Families named in the prompt (group id + optional label)',
      policyAddFamily: 'Add family',
      unsavedHint: 'unsaved',
    };

    const zh = {
      nav: '工具开关',
      title: '工具开关',
      intro:
        '选择当前对话可调用的工具。被关闭的工具会从模型的工具清单里消失，用不到的工具定义就不再占用上下文。' +
        '全局默认对所有新对话生效，每个对话也可以单独调整。',
      load: '加载',
      reload: '刷新',
      loading: '加载中…',
      failed: '无法连接工具开关服务：{reason}',
      saved: '已保存。',
      global: '全局默认',
      globalHint: '所有新对话都以这里关闭的工具开始。',
      groups: '分组',
      groupsHint:
        '工具按名字自动分类。你可以自己建分组来整理；分组开关会覆盖组内全部工具。',
      newGroup: '新建分组',
      groupName: '分组名称',
      parent: '上级分组',
      noParent: '无',
      create: '创建',
      save: '保存',
      cancel: '取消',
      delete: '删除',
      rename: '重命名',
      members: '成员',
      search: '筛选工具',
      expandAll: '全部展开',
      collapseAll: '全部收起',
      enableAll: '全部启用',
      disableAll: '全部关闭',
      applyToAll: '应用到所有对话',
      conversation: '当前对话',
      empty: '没有匹配项。',
      on: '{on}/{total}',
      off: '已关 {n}',
      allOn: '全部启用',
      catalogue: '写出的清单',
      catalogueHint:
        '每个工具、所属分组和全局默认都会写进 harness 主目录下的 JSON 文档，AI 和用户读的是同一份清单。',
      policy: '提示词策略',
      policyHint:
        '注入一段系统提示词：要求模型接手任务时先看工具目录，把这次用不上的工具族关掉，需要时再打开。' +
        '只有当开关工具本身可调用时，这段才会真的注入。',
      policyEnabled: '注入工具自检策略',
      policyExtra: '追加在策略末尾的附加要求',
      policyExtraPlaceholder: '例如：本项目是纯前端，永远不要打开逆向工具族。',
      policyPreview: '注入文本',
      policyPreviewHint: '下一次请求实际注入的内容（开关工具不可用时为空）。',
      policySave: '保存策略',
      policySaved: '策略已保存。',
      policyFamilies: '提示词里点名的工具族（组 id + 可选说明）',
      policyAddFamily: '添加工具族',
      unsavedHint: '未保存',
    };

    const EMPTY = '—';

    /** Fill `{name}` placeholders without pulling a formatter into the bundle. */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/gu, (match, key) => (key in values ? String(values[key]) : match));
    }

    /** Split a rendered name list, treating the em-dash placeholder as empty. */
    function splitNames(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0 || trimmed === EMPTY) return [];
      return trimmed
        .split(', ')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    }

    /** Parse a summary sentence into the disabled names it reports. */
    function parseSummary(text) {
      if (/All \d+ switchable tools are enabled\./u.test(text)) return [];
      const off = /(\d+) of (\d+) switchable tools are disabled: (.*)$/mu.exec(text);
      if (off !== null) return splitNames(off[3]);
      return null;
    }

    /** Read the Host's catalogue, groups, and global default. */
    async function loadState() {
      const response = await fetch(API + '/state', { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }

    /** Send one management request to the Host. */
    async function sendManage(body) {
      const response = await fetch(API + '/manage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? payload.message ?? 'HTTP ' + response.status);
      return payload;
    }

    const COLORS = {
      base: 'var(--dsw-alias-bg-overlay)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    /** Shared text-input style for the settings page (policy editor included). */
    const inputStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      height: '28px',
      padding: '0 8px',
      border: '1px solid ' + COLORS.border,
      borderRadius: '7px',
      background: COLORS.layer2,
      color: COLORS.text,
      font: 'inherit',
      boxSizing: 'border-box',
    };

    /** Painted switch. */
    function Switch({ checked, label, onToggle, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          disabled,
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle(!checked);
          },
          style: {
            flex: 'none',
            width: '32px',
            height: '18px',
            padding: 0,
            border: 'none',
            borderRadius: '9px',
            background: checked ? COLORS.brand : COLORS.idle,
            opacity: disabled ? 0.5 : 1,
            position: 'relative',
            cursor: disabled ? 'default' : 'pointer',
            transition: 'background 120ms ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: '2px',
            left: checked ? '16px' : '2px',
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 120ms ease',
          },
        }),
      );
    }

    /** A plain button that matches the host's look. */
    function Action({ children, onClick, disabled, primary }) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          style: {
            height: '28px',
            padding: '0 10px',
            border: '1px solid ' + (primary ? COLORS.brand : COLORS.border),
            borderRadius: '7px',
            background: primary ? COLORS.brand : 'transparent',
            color: primary ? '#fff' : COLORS.text,
            font: '12px/1 inherit',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          },
        },
        children,
      );
    }

    /** One tool row. */
    function ToolRow({ name, enabled, depth, onToggle, busy }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            padding: '3px 2px',
            paddingLeft: 20 + depth * 14 + 'px',
            font: '13px/1.4 inherit',
            color: COLORS.text,
          },
        },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
        h(Switch, { checked: enabled, label: name, onToggle, disabled: busy }),
      );
    }

    /** The settings page. */
    function SettingsPage(props, ctx, t) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [collapsed, setCollapsed] = React.useState(() => new Set());
      const [query, setQuery] = React.useState('');
      const [editing, setEditing] = React.useState(null);
      const [draftName, setDraftName] = React.useState('');
      const [draftParent, setDraftParent] = React.useState('');
      const [draftMembers, setDraftMembers] = React.useState([]);
      const [creating, setCreating] = React.useState(false);
      // 提示词策略区块的本地编辑态；进入页面时从 snapshot 初始化。
      const [policyDraft, setPolicyDraft] = React.useState(null);
      const [policyDirty, setPolicyDirty] = React.useState(false);
      /** ref mirror of policyDirty so the refresh callback can read it without a dep loop. */
      const policyDirtyRef = React.useRef(false);

      /** Deep-copy the policy from a snapshot into an editable draft. */
      function clonePolicy(policy) {
        const source = policy !== null && typeof policy === 'object' ? policy : {};
        return {
          enabled: source.enabled !== false,
          order: typeof source.order === 'number' ? source.order : 950,
          extra: typeof source.extra === 'string' ? source.extra : '',
          text: typeof source.text === 'string' ? source.text : '',
          families: Array.isArray(source.families) ? source.families.map((row) => ({ group: row?.group ?? '', label: row?.label ?? '' })) : [],
        };
      }

      const refresh = React.useCallback(async () => {
        try {
          const next = await loadState();
          setState(next);
          // 策略草稿只在没有未保存修改时跟随远端，避免把用户正在编辑的内容冲掉。
          setPolicyDraft((current) => (current === null || !policyDirtyRef.current ? clonePolicy(next?.policy) : current));
          setError('');
        } catch (failure) {
          setError(fill(t('failed'), { reason: String(failure) }));
        }
      }, [t]);

      React.useEffect(() => {
        void refresh();
      }, [refresh]);

      const nodes = React.useMemo(() => {
        const map = new Map();
        for (const node of state?.groups ?? []) map.set(node.id, node);
        return map;
      }, [state]);

      const roots = React.useMemo(() => [...(state?.roots ?? [])].sort(), [state]);

      const toolNames = React.useMemo(() => (state?.tools ?? []).map((row) => row.name), [state]);

      const disabledGlobal = React.useMemo(
        () => new Set(state?.global?.disabled ?? []),
        [state],
      );

      const manage = async (body) => {
        setBusy(true);
        try {
          const payload = await sendManage(body);
          if (payload.state !== undefined) setState(payload.state);
          else await refresh();
        } catch (failure) {
          setError(fill(t('failed'), { reason: String(failure) }));
        } finally {
          setBusy(false);
        }
      };

      /** Persist the policy draft through the shared manage surface. */
      const savePolicy = async () => {
        if (policyDraft === null) return;
        await manage({ action: 'policy', policy: policyDraft });
        setPolicyDirty(false);
        policyDirtyRef.current = false;
      };

      /** Update one draft field and mark it dirty. */
      const editPolicy = (patch) => {
        setPolicyDraft((current) => clonePolicy({ ...(current ?? {}), ...patch }));
        setPolicyDirty(true);
        policyDirtyRef.current = true;
      };

      const toggleCollapsed = (id) => {
        setCollapsed((current) => {
          const updated = new Set(current);
          if (updated.has(id)) updated.delete(id);
          else updated.add(id);
          return updated;
        });
      };

      const startEdit = (node) => {
        setEditing(node.id);
        setCreating(false);
        setDraftName(node.label ?? node.id);
        setDraftParent(node.parent ?? '');
        setDraftMembers(node.members ?? []);
      };

      const startCreate = () => {
        setCreating(true);
        setEditing(null);
        setDraftName('');
        setDraftParent('');
        setDraftMembers([]);
      };

      const saveGroup = async () => {
        if (creating) {
          await manage({
            action: 'group-create',
            label: draftName,
            parent: draftParent,
            tools: draftMembers,
          });
        } else {
          await manage({
            action: 'group-edit',
            id: editing,
            label: draftName,
            parent: draftParent,
            tools: draftMembers,
          });
        }
        setCreating(false);
        setEditing(null);
      };

      const removeGroup = async () => {
        if (editing === null) return;
        await manage({ action: 'group-delete', id: editing });
        setEditing(null);
      };

      const toggleMember = (name) => {
        setDraftMembers((current) =>
          current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
        );
      };

      const filtered = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle.length === 0) return [];
        return toolNames.filter((name) => name.toLowerCase().includes(needle));
      }, [toolNames, query]);

      const globalNames = state?.global?.disabled ?? [];

      /** One group row with its members. */
      const renderGroup = (node, depth) => {
        // `members` is the aggregate this group's switch covers; `direct` is what
        // this level renders itself, so a tool already shown under a child group
        // is not repeated beside it.
        const members = node.members ?? [];
        const own = node.direct ?? members;
        const off = members.filter((name) => disabledGlobal.has(name)).length;
        const expanded = !collapsed.has(node.id);
        const children = (node.children ?? []).map((childId) => nodes.get(childId)).filter(Boolean);
        const short = node.id.startsWith('u:') ? node.id.slice(2) : node.id;
        return h(
          'div',
          { key: node.id },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 2px',
                paddingLeft: 4 + depth * 14 + 'px',
              },
            },
            h(
              'button',
              {
                type: 'button',
                'aria-label': expanded ? 'collapse' : 'expand',
                'aria-expanded': expanded,
                onClick: () => toggleCollapsed(node.id),
                style: {
                  flex: 'none',
                  width: '18px',
                  height: '18px',
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: COLORS.text2,
                  cursor: 'pointer',
                  font: '11px/1 inherit',
                },
              },
              expanded ? '▾' : '▸',
            ),
            h(
              'span',
              {
                onClick: () => toggleCollapsed(node.id),
                style: {
                  flex: '1 1 auto',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  fontWeight: depth === 0 ? 600 : 400,
                  color: node.user ? COLORS.brand : COLORS.text,
                },
              },
              short,
            ),
            h(
              'span',
              { style: { flex: 'none', color: COLORS.text2, fontSize: '11px' } },
              fill(t('on'), { on: members.length - off, total: members.length }),
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => startEdit(node),
                style: {
                  flex: 'none',
                  border: 'none',
                  background: 'transparent',
                  color: COLORS.text2,
                  cursor: 'pointer',
                  font: '11px/1 inherit',
                  padding: '0 4px',
                },
              },
              t('rename'),
            ),
            h(Switch, {
              checked: off === 0,
              label: node.id,
              disabled: busy,
              onToggle: (next) => {
                const current = state?.global?.disabled ?? [];
                void manage({
                  action: 'global',
                  disabled: next
                    ? current.filter((name) => !members.includes(name))
                    : [...new Set([...current, ...members])],
                });
              },
            }),
          ),
          expanded
            ? h(
                'div',
                null,
                children.map((child) => renderGroup(child, depth + 1)),
                own
                  .slice()
                  .sort()
                  .map((name) =>
                    h(ToolRow, {
                      key: name,
                      name,
                      enabled: !disabledGlobal.has(name),
                      depth: depth + 1,
                      busy,
                      onToggle: (next) => {
                        const current = state?.global?.disabled ?? [];
                        void manage({
                          action: 'global',
                          disabled: next
                            ? current.filter((item) => item !== name)
                            : [...new Set([...current, name])],
                        });
                      },
                    }),
                  ),
              )
            : null,
        );
      };

      const editor =
        creating || editing !== null
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  padding: '10px',
                  marginTop: '8px',
                  border: '1px solid ' + COLORS.border,
                  borderRadius: '8px',
                  background: COLORS.layer,
                },
              },
              h('strong', null, creating ? t('newGroup') : t('rename')),
              h('input', {
                type: 'text',
                value: draftName,
                placeholder: t('groupName'),
                'aria-label': t('groupName'),
                onChange: (event) => setDraftName(event.target.value),
                style: {
                  height: '28px',
                  padding: '0 8px',
                  border: '1px solid ' + COLORS.border,
                  borderRadius: '7px',
                  background: COLORS.base,
                  color: COLORS.text,
                  font: 'inherit',
                },
              }),
              h(
                'select',
                {
                  value: draftParent,
                  'aria-label': t('parent'),
                  onChange: (event) => setDraftParent(event.target.value),
                  style: {
                    height: '28px',
                    padding: '0 6px',
                    border: '1px solid ' + COLORS.border,
                    borderRadius: '7px',
                    background: COLORS.base,
                    color: COLORS.text,
                    font: 'inherit',
                  },
                },
                h('option', { value: '' }, t('noParent')),
                [...nodes.values()]
                  .filter((node) => node.user)
                  .map((node) => h('option', { key: node.id, value: node.id }, node.label ?? node.id)),
              ),
              h('div', { style: { color: COLORS.text2 } }, t('members')),
              h(
                'div',
                {
                  style: {
                    maxHeight: '160px',
                    overflowY: 'auto',
                    border: '1px solid ' + COLORS.border,
                    borderRadius: '7px',
                    padding: '4px',
                  },
                },
                toolNames.map((name) =>
                  h(
                    'label',
                    {
                      key: name,
                      style: {
                        display: 'flex',
                        gap: '6px',
                        alignItems: 'center',
                        padding: '2px 4px',
                        font: '12px/1.4 inherit',
                        color: COLORS.text,
                      },
                    },
                    h('input', {
                      type: 'checkbox',
                      checked: draftMembers.includes(name),
                      onChange: () => toggleMember(name),
                    }),
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
                  ),
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '6px' } },
                h(Action, { onClick: () => void saveGroup(), primary: true, disabled: busy }, t('save')),
                h(
                  Action,
                  {
                    onClick: () => {
                      setCreating(false);
                      setEditing(null);
                    },
                  },
                  t('cancel'),
                ),
                editing !== null
                  ? h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => void removeGroup(),
                        style: {
                          height: '28px',
                          padding: '0 10px',
                          border: '1px solid ' + COLORS.error,
                          borderRadius: '7px',
                          background: 'transparent',
                          color: COLORS.error,
                          font: '12px/1 inherit',
                          cursor: 'pointer',
                        },
                      },
                      t('delete'),
                    )
                  : null,
              ),
            )
          : null;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px' } },
        h('div', { style: { color: COLORS.text2, font: '13px/1.5 inherit' } }, t('intro')),
        error.length > 0 ? h('div', { style: { color: COLORS.error } }, error) : null,
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h(Action, { onClick: () => void refresh(), disabled: busy }, t('reload')),
          state === null ? h('span', { style: { color: COLORS.text2 } }, t('loading')) : null,
        ),

        // ── 提示词策略（工具自检）───────────────────────────────────────────
        h(
          'section',
          {
            style: {
              border: '1px solid ' + COLORS.border,
              borderRadius: '10px',
              padding: '12px',
              background: COLORS.layer,
            },
          },
          h('strong', null, t('policy')),
          h('div', { style: { color: COLORS.text2, font: '12px/1.5 inherit', marginTop: '2px' } }, t('policyHint')),
          policyDraft === null
            ? null
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } },
                h(
                  'label',
                  { style: { display: 'flex', alignItems: 'center', gap: '8px', font: '13px/1.4 inherit', color: COLORS.text } },
                  h('input', {
                    type: 'checkbox',
                    checked: policyDraft.enabled === true,
                    onChange: (event) => editPolicy({ enabled: event.target.checked }),
                  }),
                  t('policyEnabled'),
                ),
                h(
                  'div',
                  { style: { color: COLORS.text2, font: '12px/1.4 inherit' } },
                  t('policyFamilies'),
                ),
                policyDraft.families.map((row, index) =>
                  h(
                    'div',
                    { key: index, style: { display: 'flex', gap: '6px' } },
                    h('input', {
                      type: 'text',
                      value: row.group,
                      placeholder: 'mcp:rea',
                      'aria-label': 'group',
                      onChange: (event) => {
                        const families = policyDraft.families.map((item, position) =>
                          position === index ? { ...item, group: event.target.value } : item,
                        );
                        editPolicy({ families });
                      },
                      style: inputStyle,
                    }),
                    h('input', {
                      type: 'text',
                      value: row.label,
                      placeholder: 'REA 逆向工程工具（200+ 个）',
                      'aria-label': 'label',
                      onChange: (event) => {
                        const families = policyDraft.families.map((item, position) =>
                          position === index ? { ...item, label: event.target.value } : item,
                        );
                        editPolicy({ families });
                      },
                      style: { ...inputStyle, flex: '2 1 auto' },
                    }),
                    h(
                      Action,
                      {
                        onClick: () =>
                          editPolicy({ families: policyDraft.families.filter((_item, position) => position !== index) }),
                      },
                      '×',
                    ),
                  ),
                ),
                h(
                  'div',
                  null,
                  h(
                    Action,
                    {
                      onClick: () => editPolicy({ families: [...policyDraft.families, { group: '', label: '' }] }),
                    },
                    t('policyAddFamily'),
                  ),
                ),
                h(
                  'div',
                  { style: { color: COLORS.text2, font: '12px/1.4 inherit' } },
                  t('policyExtra'),
                ),
                h('textarea', {
                  value: policyDraft.extra,
                  placeholder: t('policyExtraPlaceholder'),
                  rows: 2,
                  onChange: (event) => editPolicy({ extra: event.target.value }),
                  style: { ...inputStyle, resize: 'vertical', minHeight: '48px', font: 'inherit' },
                }),
                h(
                  'div',
                  { style: { color: COLORS.text2, font: '12px/1.4 inherit' } },
                  t('policyPreview') + ' — ' + t('policyPreviewHint'),
                ),
                h(
                  'pre',
                  {
                    style: {
                      margin: 0,
                      maxHeight: '220px',
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      border: '1px solid ' + COLORS.border,
                      borderRadius: '8px',
                      padding: '8px 10px',
                      background: COLORS.base,
                      color: COLORS.text,
                      font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
                    },
                  },
                  state?.policyText && policyDraft.enabled !== false
                    ? state.policyText
                    : '（空 — 策略已停用或开关工具不可见）',
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                  h(Action, { onClick: () => void savePolicy(), primary: true, disabled: busy || !policyDirty }, t('policySave')),
                  policyDirty ? h('span', { style: { color: COLORS.text2, font: '12px/1.4 inherit' } }, t('unsavedHint')) : null,
                ),
              ),
        ),

        h(
          'section',
          {
            style: {
              border: '1px solid ' + COLORS.border,
              borderRadius: '10px',
              padding: '12px',
              background: COLORS.layer,
            },
          },
          h('strong', null, t('global')),
          h('div', { style: { color: COLORS.text2, font: '12px/1.5 inherit', marginTop: '2px' } }, t('globalHint')),
          h(
            'div',
            { style: { display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' } },
            h(
              Action,
              {
                disabled: busy,
                onClick: () => {
                  void manage({ action: 'global', disabled: [] });
                },
              },
              t('enableAll'),
            ),
            h(
              Action,
              {
                disabled: busy,
                onClick: () => {
                  void manage({
                    action: 'global',
                    disabled: (state?.tools ?? []).filter((row) => row.switchable).map((row) => row.name),
                  });
                },
              },
              t('disableAll'),
            ),
            h(
              Action,
              {
                disabled: busy,
                onClick: () => {
                  void manage({ action: 'catalog' });
                },
              },
              t('catalogue'),
            ),
          ),
          h(
            'div',
            { style: { marginTop: '8px', color: COLORS.text2, font: '12px/1.5 inherit' } },
            globalNames.length === 0
              ? t('allOn')
              : fill(t('off'), { n: globalNames.length }) + ': ' + globalNames.join(', '),
          ),
        ),

        h(
          'section',
          {
            style: {
              border: '1px solid ' + COLORS.border,
              borderRadius: '10px',
              padding: '12px',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('strong', null, t('groups')),
            h(
              'div',
              { style: { display: 'flex', gap: '6px' } },
              h(
                Action,
                {
                  onClick: () =>
                    setCollapsed((current) => {
                      const updated = new Set(current)
                      for (const node of nodes.values()) updated.add(node.id)
                      return updated
                    }),
                },
                t('collapseAll'),
              ),
              h(Action, { onClick: () => setCollapsed(new Set()) }, t('expandAll')),
              h(Action, { onClick: startCreate, primary: true }, t('newGroup')),
            ),
          ),
          h('div', { style: { color: COLORS.text2, font: '12px/1.5 inherit', marginTop: '2px' } }, t('groupsHint')),
          editor,
          h('input', {
            type: 'search',
            value: query,
            placeholder: t('search'),
            'aria-label': t('search'),
            onChange: (event) => setQuery(event.target.value),
            style: {
              width: '100%',
              boxSizing: 'border-box',
              height: '28px',
              margin: '8px 0',
              padding: '0 8px',
              border: '1px solid ' + COLORS.border,
              borderRadius: '7px',
              background: COLORS.layer,
              color: COLORS.text,
              font: 'inherit',
            },
          }),
          query.trim().length > 0
            ? filtered.length === 0
              ? h('div', { style: { color: COLORS.text2 } }, t('empty'))
              : filtered.map((name) => {
                  const row = (state?.tools ?? []).find((item) => item.name === name)
                  const on = !disabledGlobal.has(name)
                  return h(
                    'div',
                    { key: name, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 2px' } },
                    h(
                      'span',
                      { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      name,
                    ),
                    h(
                      'span',
                      { style: { flex: 'none', color: COLORS.text2, fontSize: '11px' } },
                      row?.group ?? '',
                    ),
                    h(Switch, {
                      checked: on,
                      label: name,
                      disabled: busy || row?.switchable === false,
                      onToggle: (next) => {
                        const current = state?.global?.disabled ?? [];
                        void manage({
                          action: 'global',
                          disabled: next
                            ? current.filter((item) => item !== name)
                            : [...new Set([...current, name])],
                        });
                      },
                    }),
                  )
                })
            : roots.length === 0
              ? h('div', { style: { color: COLORS.text2 } }, t('empty'))
              : roots.map((id) => {
                  const node = nodes.get(id)
                  if (node === undefined) return null
                  return renderGroup(node, 0)
                }),
        ),

        h(
          'section',
          {
            style: {
              border: '1px solid ' + COLORS.border,
              borderRadius: '10px',
              padding: '12px',
            },
          },
          h('strong', null, t('catalogue')),
          h('div', { style: { color: COLORS.text2, font: '12px/1.5 inherit', marginTop: '2px' } }, t('catalogueHint')),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const prefersChinese = String(navigator.language || 'en').toLowerCase().startsWith('zh');
        let t = (key, values) => {
          const template = (prefersChinese ? zh[key] : en[key]) ?? key;
          return values === undefined ? template : fill(template, values);
        };
        try {
          const locale = ctx.get('locale');
          if (locale !== undefined && locale !== null) {
            locale.register(NS, 'en', en);
            locale.register(NS, 'zh-CN', zh);
            const bound = locale.bind(NS);
            t = (key, values) => {
              const template = bound(key) ?? key;
              return values === undefined ? template : fill(template, values);
            };
          }
        } catch (error) {
          console.error('tool-switch: locale registration failed, using inline copy', error);
        }
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'tool-switch', order: 36, label: () => t('nav'), locale: NS },
            (props) => SettingsPage(props, ctx, t),
          ),
        );
      },
    };
  },
});
