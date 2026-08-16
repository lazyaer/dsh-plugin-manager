// dsh-plugin-manager · browser half.
//
// A floating button opens a plugin-manager panel: every composed plugin row
// with an enable/disable switch (core rows are read-only), plus the audit
// log of plugin downloads (source + time). Zero dependencies: hand-written
// in the lazy-CJS bundle protocol (window.__ModuleLoader__.load), plain DOM,
// no imports from dsh client packages — the same stance as the modlens
// browser half, so the UI keeps working across host changes.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-manager',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    var API = '/api/dsh-plugin-manager'
    var POLL_MS = 5000
    var CSS_ID = 'dsh-plugin-manager-style'

    var state = { plugins: [], packages: [], audit: [], market: [], toggling: {}, error: null, profileName: '', marketLoading: false, marketInstalling: null, marketQuery: '', marketPage: 1, marketTotal: 0, marketLoaded: false }

    // ---------------------------------------------------------------- dom

    function el(tag, props, children) {
      var node = document.createElement(tag)
      if (props) {
        for (var key in props) {
          var value = props[key]
          if (key === 'class') node.className = value
          else if (key === 'text') node.textContent = value
          else if (key === 'title') node.title = value
          else if (key === 'dataset') for (var dk in value) node.dataset[dk] = value[dk]
          else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
          else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : value)
        }
      }
      if (children) {
        var list = Array.isArray(children) ? children : [children]
        for (var i = 0; i < list.length; i++) {
          var child = list[i]
          if (child === null || child === undefined || child === false) continue
          node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
        }
      }
      return node
    }

    function fmtTime(iso) {
      if (!iso) return '—'
      try {
        return new Date(iso).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return iso
      }
    }

    function shortText(value, max) {
      if (!value) return ''
      var text = String(value)
      return text.length > max ? text.slice(0, max - 1) + '…' : text
    }

    function linkOf(value) {
      if (!value) return null
      var text = String(value)
      return /^https?:\/\//i.test(text) ? text : text.startsWith('git+') ? text.slice(4) : null
    }

    function toast(message, isError) {
      var box = document.getElementById('dsh-plugin-manager-toast')
      if (!box) return
      box.textContent = message
      box.className = 'dpm-toast ' + (isError ? 'dpm-toast-error' : 'dpm-toast-ok')
      box.style.opacity = '1'
      clearTimeout(toast._timer)
      toast._timer = setTimeout(function () {
        box.style.opacity = '0'
      }, 3200)
    }

    // ---------------------------------------------------------------- api

    function apiGet(path) {
      return fetch(API + path).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || !data.ok) {
            var message = (data && data.error) || 'HTTP ' + res.status
            if (data && data.output) message += '\n' + String(data.output).slice(-500)
            throw new Error(message)
          }
          return data
        })
      })
    }

    function refresh() {
      return Promise.all([apiGet('/plugins'), apiGet('/packages'), apiGet('/audit')])
        .then(function (results) {
          state.plugins = results[0].plugins || []
          state.packages = results[1].packages || []
          state.audit = results[2].entries || []
          state.profileName = results[0].profile || ''
          state.error = null
          renderPlugins()
          renderPackages()
          renderAudit()
        })
        .catch(function (error) {
          state.error = String(error && error.message ? error.message : error)
          var status = document.getElementById('dpm-status')
          if (status) status.textContent = '连接失败: ' + state.error
        })
    }

    // ---------------------------------------------------------------- render

    function statusChip(plugin) {
      var chip = el('span', { class: 'dpm-chip ' + (plugin.enabled ? 'dpm-chip-on' : 'dpm-chip-off'), text: plugin.enabled ? '运行中' : '已禁用' })
      return chip
    }

    function kindLabel(plugin) {
      if (plugin.group) return '组'
      if (plugin.kind === 'client') return '客户端'
      if (plugin.kind === 'server') return '服务端'
      if (plugin.kind === 'mixed') return '双端'
      return '依赖'
    }

    function switchControl(plugin) {
      var button = el('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': plugin.enabled ? 'true' : 'false',
        class: 'dpm-switch ' + (plugin.enabled ? 'dpm-switch-on' : ''),
        title: plugin.protected
          ? '核心组件，不可切换'
          : plugin.enabled
            ? '禁用 ' + plugin.rowId
            : '启用 ' + plugin.rowId,
        disabled: plugin.protected || state.toggling[plugin.rowId] ? true : undefined,
      })
      button.appendChild(el('span', { class: 'dpm-switch-knob' }))
      button.addEventListener('click', function () {
        if (plugin.protected || state.toggling[plugin.rowId]) return
        var next = !plugin.enabled
        var label = plugin.name ? plugin.name + ' (' + plugin.rowId + ')' : plugin.rowId
        var message = next
          ? '启用插件「' + label + '」？'
          : '禁用插件「' + label + '」？禁用后相关功能立即不可用（HMR 即时生效）。\n\n如需恢复，重新打开本面板点击开关即可。'
        if (!window.confirm(message)) return
        state.toggling[plugin.rowId] = true
        renderPlugins()
        apiPost('/plugins/toggle', { rowId: plugin.rowId, enabled: next })
          .then(function () {
            delete state.toggling[plugin.rowId]
            toast(next ? '已启用 ' + label : '已禁用 ' + label + '（如未即时生效，请重启 dsh web）')
            refresh()
          })
          .catch(function (error) {
            delete state.toggling[plugin.rowId]
            toast('切换失败: ' + error.message, true)
            renderPlugins()
          })
      })
      return button
    }

    function pluginCard(plugin) {
      var head = el('div', { class: 'dpm-row-head' })
      var titleLine = el('div', { class: 'dpm-row-title' })
      titleLine.appendChild(el('span', { class: 'dpm-name', text: plugin.name || plugin.rowId, title: plugin.name || plugin.rowId }))
      titleLine.appendChild(el('span', { class: 'dpm-rowid', text: plugin.rowId }))
      head.appendChild(titleLine)
      head.appendChild(statusChip(plugin))
      head.appendChild(switchControl(plugin))

      var body = el('div', { class: 'dpm-row-body' })
      if (plugin.description) body.appendChild(el('div', { class: 'dpm-desc', text: plugin.description }))
      var meta = []
      meta.push('版本 ' + (plugin.version || '—'))
      meta.push(kindLabel(plugin))
      if (plugin.sourceBundle && plugin.sourceBundle !== plugin.name) meta.push('来自 ' + plugin.sourceBundle)
      var repo = linkOf(plugin.repository || plugin.homepage)
      if (repo) meta.push('来源 ' + repo)
      if (plugin.registry) meta.push('注册表 ' + plugin.registry)
      if (plugin.tarball) meta.push('tarball ' + plugin.tarball)
      meta.push('安装 ' + fmtTime(plugin.installedAt))
      var metaLine = el('div', { class: 'dpm-meta', text: meta.join(' · ') })
      metaLine.title = meta.join('\n')
      body.appendChild(metaLine)
      if (plugin.error) body.appendChild(el('div', { class: 'dpm-error', text: '解析失败: ' + plugin.error }))
      if (plugin.protected && !plugin.group) body.appendChild(el('div', { class: 'dpm-hint', text: '核心组件，受保护，不可禁用' }))

      return el('li', { class: 'dpm-card ' + (plugin.enabled ? '' : 'dpm-card-off') }, [head, body])
    }

    var pluginListEl = null
    function renderPlugins() {
      if (!pluginListEl) return
      pluginListEl.textContent = ''
      var sorted = state.plugins.slice().sort(function (a, b) {
        if (a.protected !== b.protected) return a.protected ? 1 : -1
        var ab = a.sourceBundle || ''
        var bb = b.sourceBundle || ''
        if (ab !== bb) return ab < bb ? -1 : 1
        return (a.name || a.rowId) < (b.name || b.rowId) ? -1 : 1
      })
      if (sorted.length === 0) {
        pluginListEl.appendChild(el('li', { class: 'dpm-empty', text: '未发现插件。' }))
        return
      }
      for (var i = 0; i < sorted.length; i++) pluginListEl.appendChild(pluginCard(sorted[i]))
      var status = document.getElementById('dpm-status')
      if (status) {
        var on = sorted.filter(function (p) { return p.enabled }).length
        var off = sorted.filter(function (p) { return !p.enabled }).length
        status.textContent = '共 ' + sorted.length + ' 行 · 运行中 ' + on + ' · 已禁用 ' + off + (state.error ? ' · ' + state.error : '')
      }
    }

    var packageListEl = null
    function uninstallPackage(pkg) {
      if (state.toggling[pkg.name]) return
      var label = pkg.name + '@' + (pkg.version || '?')
      var rows = (pkg.rows || []).join(', ')
      var message =
        '卸载插件包「' + label + '」？\n\n' +
        '将删除该包及其贡献的 ' + (pkg.rows || []).length + ' 个功能行' + (rows ? '（' + rows + '）' : '') + '，\n' +
        '并从 profile 的依赖与 bundle 层移除（可随时重新安装）。\n\n' +
        '运行中的 dsh web 会保持旧代码，重启后完全生效。'
      if (!window.confirm(message)) return
      if (!window.confirm('再次确认：确定卸载「' + pkg.name + '」？此操作不可撤销。')) return
      state.toggling[pkg.name] = true
      renderPackages()
      apiPost('/packages/uninstall', { packageName: pkg.name })
        .then(function (data) {
          delete state.toggling[pkg.name]
          var via = data.via === 'pnpm' ? 'pnpm' : '手动'
          toast('已卸载 ' + pkg.name + '（' + via + '），重启 dsh web 后完全生效')
          refresh()
        })
        .catch(function (error) {
          delete state.toggling[pkg.name]
          toast('卸载失败: ' + error.message, true)
          renderPackages()
        })
    }

    function renderPackages() {
      if (!packageListEl) return
      packageListEl.textContent = ''
      var list = state.packages
      if (list.length === 0) {
        packageListEl.appendChild(el('li', { class: 'dpm-empty', text: '没有可卸载的插件包。' }))
        return
      }
      for (var i = 0; i < list.length; i++) {
        var pkg = list[i]
        var head = el('div', { class: 'dpm-row-head' })
        var titleLine = el('div', { class: 'dpm-row-title' })
        titleLine.appendChild(el('span', { class: 'dpm-name', text: pkg.name, title: pkg.name }))
        titleLine.appendChild(el('span', { class: 'dpm-rowid', text: pkg.version || '' }))
        head.appendChild(titleLine)
        if (pkg.uninstallable) {
          var button = el('button', {
            type: 'button',
            class: 'dpm-uninstall',
            text: state.toggling[pkg.name] ? '卸载中…' : '卸载',
            disabled: state.toggling[pkg.name] ? true : undefined,
            title: '卸载 ' + pkg.name,
          })
          button.addEventListener('click', function (event) {
            event.stopPropagation()
            uninstallPackage(pkg)
          })
          head.appendChild(button)
        }
        var body = el('div', { class: 'dpm-row-body' })
        if (pkg.description) body.appendChild(el('div', { class: 'dpm-desc', text: pkg.description }))
        var meta = []
        meta.push(pkg.kind === 'client' ? '客户端' : pkg.kind === 'server' ? '服务端' : pkg.kind === 'mixed' ? '双端' : pkg.kind)
        meta.push('功能行 ' + ((pkg.rows || []).length || 0) + ' 个')
        var repo = linkOf(pkg.repository || pkg.homepage)
        if (repo) meta.push('来源 ' + repo)
        if (pkg.registry) meta.push('注册表 ' + pkg.registry)
        meta.push('安装 ' + fmtTime(pkg.installedAt))
        var metaLine = el('div', { class: 'dpm-meta', text: meta.join(' · ') })
        metaLine.title = meta.join('\n')
        body.appendChild(metaLine)
        if (pkg.rows && pkg.rows.length > 0) {
          var chips = el('div', { class: 'dpm-chips' })
          for (var j = 0; j < pkg.rows.length; j++) {
            chips.appendChild(el('code', { class: 'dpm-rowid', text: pkg.rows[j] }))
          }
          body.appendChild(chips)
        }
        packageListEl.appendChild(el('li', { class: 'dpm-card' }, [head, body]))
      }
    }

    var marketListEl = null
    var marketStatusEl = null
    var marketPrevEl = null
    var marketNextEl = null

    function marketQueryString() {
      var parts = []
      if (state.marketQuery) parts.push('q=' + encodeURIComponent(state.marketQuery))
      parts.push('page=' + state.marketPage)
      parts.push('perPage=20')
      return parts.join('&')
    }

    function refreshMarket() {
      state.marketLoading = true
      if (marketStatusEl) marketStatusEl.textContent = '加载中…'
      renderMarket()
      apiGet('/market?' + marketQueryString())
        .then(function (data) {
          state.market = data.items || []
          state.marketTotal = data.total || 0
          state.marketLoading = false
          state.error = null
          renderMarket()
        })
        .catch(function (error) {
          state.marketLoading = false
          state.error = String(error && error.message ? error.message : error)
          if (marketStatusEl) marketStatusEl.textContent = '加载失败: ' + state.error
          renderMarket()
        })
    }

    function installMarket(item) {
      var spec = item.installSpec
      if (!spec || state.marketInstalling) return
      var label = item.fullName || spec
      var command = 'dsh plugin --profile ' + (state.profileName || '<profile>') + ' add ' + spec
      var message =
        '安装插件「' + label + '」？\n\n' +
        '将执行命令：\n' + command + '\n\n' +
        '安装完成后需要重启 dsh web 才能完全生效。'
      if (!window.confirm(message)) return
      state.marketInstalling = spec
      renderMarket()
      apiPost('/market/install', { spec: spec })
        .then(function (data) {
          state.marketInstalling = null
          toast('已安装 ' + label + '（重启 dsh web 后生效）')
          refresh()
          refreshMarket()
        })
        .catch(function (error) {
          state.marketInstalling = null
          toast('安装失败: ' + error.message, true)
          renderMarket()
        })
    }

    function renderMarket() {
      if (!marketListEl) return
      marketListEl.textContent = ''
      if (marketPrevEl) marketPrevEl.disabled = state.marketPage <= 1
      if (marketNextEl) marketNextEl.disabled = state.marketLoading || state.market.length === 0 || (state.marketTotal > 0 && state.marketPage * 20 >= state.marketTotal)
      if (marketStatusEl) {
        if (state.marketLoading && state.market.length === 0) {
          marketStatusEl.textContent = '加载中…'
        } else if (state.market.length === 0 && !state.marketLoading) {
          marketStatusEl.textContent = '没有找到插件。' + (state.error ? ' · ' + state.error : '')
        } else {
          var totalText = state.marketTotal ? '共 ' + state.marketTotal + ' 个插件' : ''
          marketStatusEl.textContent = (totalText ? totalText + ' · ' : '') + '第 ' + state.marketPage + ' 页' + (state.error ? ' · ' + state.error : '')
        }
      }
      if (state.market.length === 0) {
        if (!state.marketLoading) marketListEl.appendChild(el('li', { class: 'dpm-empty', text: '未找到匹配的 harness 插件。试试搜索关键词，或检查网络后重试。' }))
        return
      }
      for (var i = 0; i < state.market.length; i++) {
        var item = state.market[i]
        var head = el('div', { class: 'dpm-row-head' })
        var titleLine = el('div', { class: 'dpm-row-title' })
        titleLine.appendChild(el('span', { class: 'dpm-name', text: item.fullName || item.name || item.installSpec, title: item.fullName || item.name || item.installSpec }))
        head.appendChild(titleLine)
        if (item.installed) head.appendChild(el('span', { class: 'dpm-chip dpm-chip-on', text: '已安装' }))
        var button = el('button', {
          type: 'button',
          class: 'dpm-install',
          text: state.marketInstalling === item.installSpec ? '安装中…' : item.installed ? '已安装' : '安装',
          disabled: item.installed || state.marketInstalling ? true : undefined,
          title: item.installed ? '该插件已安装' : '安装 ' + item.fullName,
        })
        if (!item.installed) {
          button.addEventListener('click', function (event) {
            event.stopPropagation()
            installMarket(item)
          })
        }
        head.appendChild(button)

        var body = el('div', { class: 'dpm-row-body' })
        if (item.description) body.appendChild(el('div', { class: 'dpm-desc', text: item.description }))
        var meta = []
        if (item.language) meta.push(item.language)
        meta.push('⭐ ' + item.stars)
        if (item.forks) meta.push('fork ' + item.forks)
        meta.push('更新 ' + fmtTime(item.updatedAt))
        if (item.installSpec) meta.push(item.installSpec)
        var metaLine = el('div', { class: 'dpm-meta', text: meta.join(' · ') })
        metaLine.title = meta.join('\n')
        body.appendChild(metaLine)
        if (item.url) body.appendChild(el('a', { class: 'dpm-link', href: item.url, target: '_blank', rel: 'noopener', text: item.url }))
        marketListEl.appendChild(el('li', { class: 'dpm-card' }, [head, body]))
      }
    }

    var auditListEl = null
    function renderAudit() {
      if (!auditListEl) return
      auditListEl.textContent = ''
      var entries = state.audit
      if (entries.length === 0) {
        auditListEl.appendChild(el('li', { class: 'dpm-empty', text: '暂无审计记录。安装 / 更新 / 卸载插件后会自动记录（含来源与时间）。' }))
        return
      }
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i]
        var eventLabel = { installed: '安装', updated: '更新', removed: '移除', baseline: '基线' }[entry.event] || entry.event
        var chip = el('span', {
          class: 'dpm-chip ' + (entry.event === 'removed' ? 'dpm-chip-off' : entry.event === 'baseline' ? 'dpm-chip-base' : 'dpm-chip-on'),
          text: eventLabel,
        })
        var line = el('div', { class: 'dpm-audit-line' })
        line.appendChild(el('span', { class: 'dpm-audit-time', text: fmtTime(entry.t) }))
        line.appendChild(chip)
        line.appendChild(el('span', { class: 'dpm-audit-name', text: entry.name + (entry.version ? '@' + entry.version : '') }))
        var parts = []
        if (entry.repository) parts.push('来源 ' + entry.repository)
        if (entry.registry) parts.push('注册表 ' + entry.registry)
        if (entry.tarball) parts.push(entry.tarball)
        if (entry.installedAt) parts.push('安装时间 ' + fmtTime(entry.installedAt))
        if (entry.detected === 'startup') parts.push('启动时发现')
        var metaLine = el('div', { class: 'dpm-meta', text: parts.join(' · ') || '—' })
        metaLine.title = metaLine.textContent
        var item = el('li', { class: 'dpm-audit-item' }, [line, metaLine])
        auditListEl.appendChild(item)
      }
    }

    // ---------------------------------------------------------------- chrome

    function ensureStyle() {
      if (document.getElementById(CSS_ID)) return
      var style = document.createElement('style')
      style.id = CSS_ID
      style.dataset.plugin = 'dsh-plugin-manager'
      style.dataset.pluginCss = 'dsh-plugin-manager/style'
      style.textContent = [
        '#dsh-plugin-manager-fab{position:fixed;right:18px;bottom:120px;z-index:2147483000;width:46px;height:46px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-alias-bg-layer-3,#1c1c1e);color:var(--dsw-alias-label-primary,#eee);font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.35);transition:transform .12s}',
        '#dsh-plugin-manager-fab:hover{transform:scale(1.06)}',
        '#dsh-plugin-manager-panel{position:fixed;inset:0;z-index:2147483001;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.38);font-family:var(--dsw-alias-font-family,ui-sans-serif,system-ui,sans-serif)}',
        '#dsh-plugin-manager-panel.dpm-open{display:flex}',
        '.dpm-card-panel{width:min(820px,94vw);max-height:86vh;display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-alias-bg-layer-1,#17171a);color:var(--dsw-alias-label-primary,#eee);box-shadow:0 18px 60px rgba(0,0,0,.5);overflow:hidden}',
        '.dpm-panel-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2,#2a2a2e)}',
        '.dpm-panel-title{font-size:15px;font-weight:600}',
        '.dpm-panel-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#999);margin-left:2px}',
        '.dpm-panel-close{margin-left:auto;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#bbb);font-size:16px;cursor:pointer}',
        '.dpm-panel-close:hover{background:var(--dsw-alias-bg-layer-3,#222)}',
        '.dpm-tabs{display:flex;gap:4px;padding:8px 18px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#2a2a2e)}',
        '.dpm-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#999);font:inherit;font-size:13px;padding:8px 14px;border-radius:8px 8px 0 0;cursor:pointer}',
        '.dpm-tab.dpm-tab-on{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-bg-layer-2,#202024);font-weight:600}',
        '.dpm-body{flex:1;overflow:auto;padding:12px 18px 16px}',
        '.dpm-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
        '#dpm-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#999);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dpm-refresh{appearance:none;border:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-alias-bg-layer-2,#202024);color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer}',
        '.dpm-refresh:hover{background:var(--dsw-alias-bg-layer-3,#26262a)}',
        '.dpm-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
        '.dpm-card{border:1px solid var(--dsw-alias-border-l2,#2a2a2e);background:var(--dsw-alias-bg-layer-2,#1e1e22);border-radius:10px;padding:10px 12px}',
        '.dpm-card-off{opacity:.72}',
        '.dpm-row-head{display:flex;align-items:center;gap:8px}',
        '.dpm-row-title{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1}',
        '.dpm-name{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dpm-rowid{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);font-family:ui-monospace,Consolas,monospace}',
        '.dpm-row-body{margin-top:6px;display:flex;flex-direction:column;gap:4px}',
        '.dpm-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#bbb);line-height:1.5}',
        '.dpm-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dpm-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}',
        '.dpm-error{font-size:11px;color:#f0a0a0}',
        '.dpm-chip{font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap}',
        '.dpm-chip-on{background:rgba(52,199,89,.16);color:#34c759}',
        '.dpm-chip-off{background:rgba(255,69,58,.14);color:#ff453a}',
        '.dpm-chip-base{background:rgba(90,140,255,.14);color:#6a9cff}',
        '.dpm-switch{appearance:none;border:0;width:38px;height:22px;border-radius:999px;background:var(--dsw-alias-border-l2,#3a3a40);cursor:pointer;position:relative;transition:background .14s;flex:none}',
        '.dpm-switch:disabled{cursor:not-allowed;opacity:.45}',
        '.dpm-switch-on{background:#34c759}',
        '.dpm-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .14s}',
        '.dpm-switch-on .dpm-switch-knob{left:18px}',
        '.dpm-empty{padding:18px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary,#999)}',
        '.dpm-audit-item{border:1px solid var(--dsw-alias-border-l2,#2a2a2e);background:var(--dsw-alias-bg-layer-2,#1e1e22);border-radius:10px;padding:8px 12px;display:flex;flex-direction:column;gap:4px}',
        '.dpm-audit-line{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dpm-audit-time{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);font-family:ui-monospace,Consolas,monospace;white-space:nowrap}',
        '.dpm-audit-name{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dpm-chips{display:flex;flex-wrap:wrap;gap:4px}',
        '.dpm-chips .dpm-rowid{background:var(--dsw-alias-bg-layer-3,#26262a);border-radius:4px;padding:1px 6px}',
        '.dpm-uninstall{appearance:none;border:1px solid rgba(255,69,58,.5);background:rgba(255,69,58,.12);color:#ff6b5e;font:inherit;font-size:12px;padding:4px 12px;border-radius:8px;cursor:pointer;flex:none}',
        '.dpm-uninstall:hover{background:rgba(255,69,58,.22)}',
        '.dpm-uninstall:disabled{opacity:.5;cursor:wait}',
        '.dpm-search{flex:1;min-width:120px;border:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-alias-bg-layer-2,#202024);color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:12px;padding:6px 10px;border-radius:8px}',
        '.dpm-search:focus{outline:1px solid var(--dsw-alias-border-l2,#555)}',
        '.dpm-install{appearance:none;border:1px solid rgba(52,199,89,.5);background:rgba(52,199,89,.14);color:#4cd964;font:inherit;font-size:12px;padding:4px 12px;border-radius:8px;cursor:pointer;flex:none}',
        '.dpm-install:hover:not(:disabled){background:rgba(52,199,89,.24)}',
        '.dpm-install:disabled{opacity:.5;cursor:not-allowed}',
        '.dpm-pager{appearance:none;border:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-alias-bg-layer-2,#202024);color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;cursor:pointer}',
        '.dpm-pager:disabled{opacity:.4;cursor:not-allowed}',
        '.dpm-link{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dpm-link:hover{color:var(--dsw-alias-label-primary,#eee);text-decoration:underline}',
        '.dpm-toast{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483002;padding:9px 16px;border-radius:10px;font-size:13px;color:#fff;background:#2a2a2e;box-shadow:0 6px 24px rgba(0,0,0,.4);opacity:0;transition:opacity .25s;max-width:86vw}',
        '.dpm-toast-ok{background:#1f6f43}',
        '.dpm-toast-error{background:#a0332e}',
        '.dpm-foot{padding:8px 18px 12px;border-top:1px solid var(--dsw-alias-border-l2,#2a2a2e);font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}',
      ].join('\n')
      document.head.appendChild(style)
    }

    var fab = null
    var panel = null
    var pollTimer = null

    function openPanel() {
      if (!panel) return
      panel.classList.add('dpm-open')
      refresh()
    }

    function closePanel() {
      if (panel) panel.classList.remove('dpm-open')
    }

    function mount() {
      ensureStyle()
      if (document.getElementById('dsh-plugin-manager-fab')) return

      fab = el('button', {
        id: 'dsh-plugin-manager-fab',
        type: 'button',
        title: '插件管理',
        'aria-label': '插件管理',
      })
      fab.appendChild(el('span', { text: '🧩' }))
      fab.addEventListener('click', openPanel)

      panel = el('div', { id: 'dsh-plugin-manager-panel' })
      panel.addEventListener('click', function (event) {
        if (event.target === panel) closePanel()
      })

      var card = el('div', { class: 'dpm-card-panel' })

      var head = el('div', { class: 'dpm-panel-head' })
      head.appendChild(el('span', { class: 'dpm-panel-title', text: '插件管理' }))
      head.appendChild(el('span', { class: 'dpm-panel-sub', text: '启用 / 禁用 · 卸载 · 插件市场 · 下载审计（来源与时间）' }))
      head.appendChild(el('button', { type: 'button', class: 'dpm-panel-close', 'aria-label': '关闭', text: '✕' }))
      head.lastChild.addEventListener('click', closePanel)

      var tabs = el('div', { class: 'dpm-tabs' })
      var tabPlugins = el('button', { type: 'button', class: 'dpm-tab dpm-tab-on', text: '插件列表' })
      var tabPackages = el('button', { type: 'button', class: 'dpm-tab', text: '已安装包' })
      var tabMarket = el('button', { type: 'button', class: 'dpm-tab', text: '插件市场' })
      var tabAudit = el('button', { type: 'button', class: 'dpm-tab', text: '审计记录' })
      tabs.appendChild(tabPlugins)
      tabs.appendChild(tabPackages)
      tabs.appendChild(tabMarket)
      tabs.appendChild(tabAudit)

      var body = el('div', { class: 'dpm-body' })

      var pluginsSection = el('div', { id: 'dpm-section-plugins' })
      var toolbar = el('div', { class: 'dpm-toolbar' })
      toolbar.appendChild(el('span', { id: 'dpm-status', text: '加载中…' }))
      toolbar.appendChild(el('button', { type: 'button', class: 'dpm-refresh', text: '刷新' }))
      toolbar.lastChild.addEventListener('click', refresh)
      pluginsSection.appendChild(toolbar)
      pluginListEl = el('ul', { class: 'dpm-list' })
      pluginsSection.appendChild(pluginListEl)

      var packagesSection = el('div', { id: 'dpm-section-packages', style: 'display:none' })
      var packagesToolbar = el('div', { class: 'dpm-toolbar' })
      packagesToolbar.appendChild(el('span', { class: 'dpm-status2', text: 'profile 中已安装的插件包（含其贡献的功能行）。卸载 = 移除依赖 + bundle 层 + 磁盘文件，审计同步记录。' }))
      packagesToolbar.appendChild(el('button', { type: 'button', class: 'dpm-refresh', text: '刷新' }))
      packagesToolbar.lastChild.addEventListener('click', refresh)
      packagesSection.appendChild(packagesToolbar)
      packageListEl = el('ul', { class: 'dpm-list' })
      packagesSection.appendChild(packageListEl)

      var marketSection = el('div', { id: 'dpm-section-market', style: 'display:none' })
      var marketToolbar = el('div', { class: 'dpm-toolbar' })
      var marketSearch = el('input', { type: 'search', class: 'dpm-search', placeholder: '搜索 harness 插件（GitHub topic:dsh-plugin）', value: state.marketQuery })
      marketToolbar.appendChild(marketSearch)
      var marketSearchBtn = el('button', { type: 'button', class: 'dpm-refresh', text: '搜索' })
      marketSearchBtn.addEventListener('click', function () {
        state.marketQuery = marketSearch.value.trim()
        state.marketPage = 1
        refreshMarket()
      })
      marketToolbar.appendChild(marketSearchBtn)
      marketToolbar.appendChild(el('button', { type: 'button', class: 'dpm-refresh', text: '刷新' }))
      marketToolbar.lastChild.addEventListener('click', refreshMarket)
      marketPrevEl = el('button', { type: 'button', class: 'dpm-pager', text: '上一页', disabled: state.marketPage <= 1 ? true : undefined })
      marketPrevEl.addEventListener('click', function () {
        if (state.marketPage > 1) {
          state.marketPage -= 1
          refreshMarket()
        }
      })
      marketToolbar.appendChild(marketPrevEl)
      marketNextEl = el('button', { type: 'button', class: 'dpm-pager', text: '下一页' })
      marketNextEl.addEventListener('click', function () {
        state.marketPage += 1
        refreshMarket()
      })
      marketToolbar.appendChild(marketNextEl)
      marketStatusEl = el('span', { class: 'dpm-status2', text: '加载中…' })
      marketToolbar.appendChild(marketStatusEl)
      marketSection.appendChild(marketToolbar)
      marketListEl = el('ul', { class: 'dpm-list' })
      marketSection.appendChild(marketListEl)

      var auditSection = el('div', { id: 'dpm-section-audit', style: 'display:none' })
      var auditToolbar = el('div', { class: 'dpm-toolbar' })
      auditToolbar.appendChild(el('span', { class: 'dpm-status2', text: '安装 / 更新 / 卸载插件时自动记录来源与时间；dsh 未运行期间的变更会在下次启动补记。' }))
      auditToolbar.appendChild(el('button', { type: 'button', class: 'dpm-refresh', text: '立即扫描' }))
      auditToolbar.lastChild.addEventListener('click', function () {
        apiPost('/audit/rescan', {})
          .then(function () {
            toast('扫描完成')
            refresh()
          })
          .catch(function (error) {
            toast('扫描失败: ' + error.message, true)
          })
      })
      auditSection.appendChild(auditToolbar)
      auditListEl = el('ul', { class: 'dpm-list' })
      auditSection.appendChild(auditListEl)

      body.appendChild(pluginsSection)
      body.appendChild(packagesSection)
      body.appendChild(marketSection)
      body.appendChild(auditSection)

      var foot = el('div', { class: 'dpm-foot', text: 'dsh-plugin-manager · 修改写入 profile 的 cordis.patch.yml，由 dsh web 热重载生效 · 审计日志: ~/.dsh/plugin-manager/audit.jsonl' })

      card.appendChild(head)
      card.appendChild(tabs)
      card.appendChild(body)
      card.appendChild(foot)
      panel.appendChild(card)
      document.body.appendChild(panel)

      var toastEl = el('div', { id: 'dsh-plugin-manager-toast', class: 'dpm-toast' })
      document.body.appendChild(toastEl)

      tabPlugins.addEventListener('click', function () {
        tabPlugins.classList.add('dpm-tab-on')
        tabPackages.classList.remove('dpm-tab-on')
        tabMarket.classList.remove('dpm-tab-on')
        tabAudit.classList.remove('dpm-tab-on')
        pluginsSection.style.display = ''
        packagesSection.style.display = 'none'
        marketSection.style.display = 'none'
        auditSection.style.display = 'none'
      })
      tabPackages.addEventListener('click', function () {
        tabPackages.classList.add('dpm-tab-on')
        tabPlugins.classList.remove('dpm-tab-on')
        tabMarket.classList.remove('dpm-tab-on')
        tabAudit.classList.remove('dpm-tab-on')
        packagesSection.style.display = ''
        pluginsSection.style.display = 'none'
        marketSection.style.display = 'none'
        auditSection.style.display = 'none'
      })
      tabMarket.addEventListener('click', function () {
        tabMarket.classList.add('dpm-tab-on')
        tabPlugins.classList.remove('dpm-tab-on')
        tabPackages.classList.remove('dpm-tab-on')
        tabAudit.classList.remove('dpm-tab-on')
        marketSection.style.display = ''
        pluginsSection.style.display = 'none'
        packagesSection.style.display = 'none'
        auditSection.style.display = 'none'
        if (!state.marketLoaded) {
          state.marketLoaded = true
          refreshMarket()
        }
      })
      tabAudit.addEventListener('click', function () {
        tabAudit.classList.add('dpm-tab-on')
        tabPlugins.classList.remove('dpm-tab-on')
        tabPackages.classList.remove('dpm-tab-on')
        tabMarket.classList.remove('dpm-tab-on')
        auditSection.style.display = ''
        pluginsSection.style.display = 'none'
        packagesSection.style.display = 'none'
        marketSection.style.display = 'none'
      })

      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closePanel()
      })

      pollTimer = setInterval(function () {
        if (panel && panel.classList.contains('dpm-open')) {
          refresh()
          if (state.marketLoaded && marketSection.style.display !== 'none') refreshMarket()
        }
      }, POLL_MS)
      document.body.appendChild(fab)
      refresh()
    }

    function unmount() {
      if (pollTimer) clearInterval(pollTimer)
      var ids = ['dsh-plugin-manager-fab', 'dsh-plugin-manager-panel', 'dsh-plugin-manager-toast']
      for (var i = 0; i < ids.length; i++) {
        var node = document.getElementById(ids[i])
        if (node && node.parentNode) node.parentNode.removeChild(node)
      }
      fab = null
      panel = null
      pollTimer = null
    }

    exports.apply = function (ctx) {
      mount()
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () { return unmount }, 'dsh-plugin-manager: ui')
      }
    }
    exports.inject = []
    return module.exports
  },
})
