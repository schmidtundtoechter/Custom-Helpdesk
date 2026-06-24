/**
 * helpdesk_portal.js — Custom Helpdesk extension for the Frappe Helpdesk Vue SPA.
 *
 * Injected via the www/helpdesk/index.html template override. This file runs
 * in the Helpdesk portal context (/helpdesk/*), not the ERPNext Desk.
 *
 * Features:
 *  - Agent ticket view (/helpdesk/tickets/:id):
 *      Ticket Info panel: project + support category fields (F6)
 *      Zeiterfassung panel: timer start/stop, live counter (F8), multiplier,
 *        manual override (F2), description (F5), price category,
 *        selective Buchen (F9), Rücksprache, history
 *      MutationObserver to survive Vue tab switches (F4)
 *  - Customer ticket view (/helpdesk/my-tickets/:id):
 *      Closed ticket banner + disabled reply area
 */
(function () {
  'use strict';

  // ── Frappe REST helpers ─────────────────────────────────────────────────────

  function csrfToken() {
    return window.csrf_token || window.frappe_csrf_token || '';
  }

  function apiFetch(url, options) {
    return fetch(url, Object.assign({
      headers: Object.assign({
        'Content-Type': 'application/json',
        'X-Frappe-CSRF-Token': csrfToken(),
      }, (options || {}).headers || {}),
    }, options || {})).then(function (r) { return r.json(); });
  }

  function apiGet(resource, params) {
    var qs = Object.keys(params || {}).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return apiFetch('/api/resource/' + resource + (qs ? '?' + qs : ''));
  }

  function apiMethod(method, args) {
    return apiFetch('/api/method/' + method, {
      method: 'POST',
      body: JSON.stringify(args || {}),
    });
  }

  // ── Route helpers ───────────────────────────────────────────────────────────

  function agentTicketId() {
    var m = location.pathname.match(/\/helpdesk\/tickets\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function customerTicketId() {
    var m = location.pathname.match(/\/helpdesk\/my-tickets\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ── Price category cache ────────────────────────────────────────────────────

  var _priceCatCache = null;
  var _closedStatusNames = new Set();
  var _klassifizierungOptions = [];
  var _closingInterceptorInstalled = false;

  function getPriceCategories() {
    if (_priceCatCache) return Promise.resolve(_priceCatCache);
    return apiGet('Support Price Category', {
      fields: JSON.stringify(['name', 'time_code', 'category_name', 'price_per_hour']),
      filters: JSON.stringify([['is_active', '=', 1]]),
      limit: 50,
    }).then(function (res) {
      _priceCatCache = res.data || [];
      return _priceCatCache;
    });
  }

  var _agentCache = null;

  function getAgents() {
    if (_agentCache) return Promise.resolve(_agentCache);
    return apiMethod(
      'custom_helpdesk.python_scripts.billing.portal_api.get_agents', {}
    ).then(function (res) {
      _agentCache = res.message || [];
      return _agentCache;
    });
  }

  var _projectCacheByTicket = {};

  function getProjects(ticketId) {
    if (_projectCacheByTicket[ticketId]) return Promise.resolve(_projectCacheByTicket[ticketId]);
    return apiMethod(
      'custom_helpdesk.python_scripts.billing.portal_api.get_projects',
      { ticket_name: ticketId || '' }
    ).then(function (res) {
      _projectCacheByTicket[ticketId] = res.message || [];
      return _projectCacheByTicket[ticketId];
    });
  }

  // ── Time log data ───────────────────────────────────────────────────────────

  function getTimeLogs(ticketName) {
    // Direct REST access to child tables (istable=1) is blocked by Frappe with 403.
    // Use a whitelisted method on the parent ticket instead.
    return apiMethod(
      'custom_helpdesk.python_scripts.billing.portal_api.get_time_logs',
      { ticket_name: ticketName }
    ).then(function (res) { return res.message || []; });
  }

  function getTicketItems(ticketName) {
    return apiMethod(
      'custom_helpdesk.python_scripts.billing.portal_api.get_ticket_items',
      { ticket_name: ticketName }
    ).then(function (res) { return res.message || []; });
  }

  function loadClosingData() {
    apiMethod(
      'custom_helpdesk.python_scripts.billing.portal_api.get_closed_statuses', {}
    ).then(function (res) {
      if (res.message) res.message.forEach(function (s) { _closedStatusNames.add(s); });
    });
    apiGet('HD Klassifizierung', {
      fields: JSON.stringify(['name']),
      limit: 100,
      order_by: 'name asc',
    }).then(function (res) {
      if (res.data) _klassifizierungOptions = res.data.map(function (x) { return x.name; });
    });
  }

  // ── Panel DOM helpers ───────────────────────────────────────────────────────

  var PANEL_ID = 'ch-zeiterfassung-panel';
  var TICKET_INFO_ID = 'ch-ticket-info-panel';
  var ITEMS_PANEL_ID = 'ch-support-items-panel';
  var TERMINE_PANEL_ID = 'ch-termine-panel';
  var CUSTOMER_TIMES_ID = 'ch-customer-times-panel';
  var _customerObserver = null;

  var TERMIN_COLORS = {
    'Notdienst': '#8B0000',
    'Urlaub': '#2E7D32',
    'Home Office': '#E57373',
    'Außer Haus': '#F57C00',
    'Remote-Inhouse': '#1565C0',
  };

  // F4 — globals for MutationObserver panel re-injection
  var _mutationObserver = null;
  var _reinjecting = false;

  // F8 — global for live timer interval
  var _timerInterval = null;

  function el(tag, styles, attrs) {
    var node = document.createElement(tag);
    if (styles) node.style.cssText = styles;
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  function badge(text, bg, fg) {
    var s = el('span', 'padding:2px 6px;border-radius:4px;font-size:11px;background:' + bg + ';color:' + fg);
    s.textContent = text;
    return s;
  }

  function btn(text, styles, onClick) {
    var b = el('button', 'padding:6px 12px;border-radius:4px;cursor:pointer;font-size:13px;' + styles);
    b.textContent = text;
    b.onclick = onClick;
    return b;
  }

  function fmtDT(dt) {
    return dt ? String(dt).slice(0, 16).replace('T', ' ') : '–';
  }

  // ── F4 — MutationObserver: re-inject panel when Vue removes it ──────────────

  function watchForPanelRemoval(ticketId) {
    if (_mutationObserver) _mutationObserver.disconnect();
    _mutationObserver = new MutationObserver(function () {
      if (_reinjecting) return;
      if (!document.getElementById(PANEL_ID)) {
        _reinjecting = true;
        setTimeout(function () {
          renderPanel(ticketId).then(function () {
            _reinjecting = false;
            renderItemsPanel(ticketId);
            renderTerminePanel(ticketId);
          });
        }, 400);
      }
    });
    _mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function renderBoth(ticketId) {
    return renderPanel(ticketId).then(function () {
      renderItemsPanel(ticketId);
      renderTerminePanel(ticketId);
    });
  }

  // ── Agent Zeiterfassung panel ───────────────────────────────────────────────

  function removePanel() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (_mutationObserver) { _mutationObserver.disconnect(); _mutationObserver = null; }
    if (_customerObserver) { _customerObserver.disconnect(); _customerObserver = null; }
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    var info = document.getElementById(TICKET_INFO_ID);
    if (info) info.remove();
    var items = document.getElementById(ITEMS_PANEL_ID);
    if (items) items.remove();
    var termine = document.getElementById(TERMINE_PANEL_ID);
    if (termine) termine.remove();
    var custTimes = document.getElementById(CUSTOMER_TIMES_ID);
    if (custTimes) custTimes.remove();
  }

  // ── F6 — Ticket Info panel (Project + Support Category) ────────────────────

  function renderTicketInfoPanel(ticketId) {
    return apiMethod(
      'custom_helpdesk.python_scripts.billing.portal_api.get_ticket_details',
      { ticket_name: ticketId }
    ).then(function (res) {
      var details = res.message || {};

      var infoPanel = el('div',
        'margin:8px 20px 0;padding:10px 16px;border:1px solid #d1d5db;border-radius:8px;' +
        'background:#f9fafb;font-size:13px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;'
      );
      infoPanel.id = TICKET_INFO_ID;

      var lbl = el('strong', 'white-space:nowrap;');
      lbl.textContent = 'Ticket Details:';
      infoPanel.appendChild(lbl);

      // Project field
      var projWrap = el('span', 'display:flex;align-items:center;gap:6px;');
      var projLbl = el('span', 'color:#6b7280;');
      projLbl.textContent = 'Projekt:';
      var projInput = el('input',
        'border:1px solid #d1d5db;border-radius:3px;padding:3px 6px;font-size:13px;min-width:140px;'
      );
      projInput.value = details.project || '';
      projInput.placeholder = 'Projekt-ID';
      projInput.title = 'Link → Project (ERPNext)';
      projInput.addEventListener('change', function () {
        apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_ticket_details', {
          ticket_name: ticketId,
          data: JSON.stringify({ project: projInput.value }),
        });
      });
      projWrap.appendChild(projLbl);
      projWrap.appendChild(projInput);
      infoPanel.appendChild(projWrap);

      // Support Category field
      var scWrap = el('span', 'display:flex;align-items:center;gap:6px;');
      var scLbl = el('span', 'color:#6b7280;');
      scLbl.textContent = 'Support-Kategorie:';
      var scInput = el('input',
        'border:1px solid #d1d5db;border-radius:3px;padding:3px 6px;font-size:13px;min-width:140px;'
      );
      scInput.value = details.support_category || '';
      scInput.placeholder = 'Kategorie-ID';
      scInput.title = 'Link → Support Category (ERPNext)';
      scInput.addEventListener('change', function () {
        apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_ticket_details', {
          ticket_name: ticketId,
          data: JSON.stringify({ support_category: scInput.value }),
        });
      });
      scWrap.appendChild(scLbl);
      scWrap.appendChild(scInput);
      infoPanel.appendChild(scWrap);

      _insertPanel(infoPanel);
    }).catch(function (err) {
      console.error('[custom_helpdesk] Ticket info panel error:', err);
    });
  }

  function renderPanel(ticketId) {
    return Promise.all([getTimeLogs(ticketId), getPriceCategories(), getAgents(), getProjects(ticketId)]).then(function (results) {
      var logs = results[0];
      var priceCats = results[1];
      var agents = results[2];
      var projects = results[3];
      var pcMap = {};
      priceCats.forEach(function (p) { pcMap[p.name] = p; });

      removePanel();

      // Totals
      var totalH = 0, unbilledH = 0;
      logs.forEach(function (r) {
        var h = (parseFloat(r.effective_duration) || 0) * (parseInt(r.multiplier) || 1);
        if (!r.gesperrt) totalH += h;
        if (!r.is_invoiced) unbilledH += h;
      });

      // F9 — bookable = not locked, not invoiced, not already submitted
      var hasBookable = logs.some(function (r) { return !r.gesperrt && !r.is_invoiced && !r.timesheet_ref; });

      // Panel container
      var panel = el('div', 'margin:20px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-family:inherit;font-size:14px;');
      panel.id = PANEL_ID;

      // Header
      var header = el('div', 'padding:12px 16px;border-bottom:1px solid #d1d5db;display:flex;align-items:center;gap:12px;cursor:pointer;');
      var headerTitle = el('strong', 'font-size:14px;');
      headerTitle.textContent = 'Zeiterfassung';
      var headerStats = el('span', 'font-size:13px;color:#6b7280;');
      headerStats.textContent = totalH.toFixed(2) + 'h gesamt · ' + unbilledH.toFixed(2) + 'h unbezahlt';
      var arrow = el('span', 'margin-left:auto;');
      arrow.textContent = '▼';
      header.appendChild(headerTitle);
      header.appendChild(headerStats);
      header.appendChild(arrow);

      // Body
      var body = el('div', 'padding:12px 16px;');

      // Timer buttons row
      var btnRow = el('div', 'display:flex;gap:8px;margin-bottom:12px;align-items:center;');

      // Start button is always enabled — multiple agents can run timers simultaneously
      var startBtn = btn(
        '▶ Start Timer',
        'border:1px solid #10b981;background:#10b981;color:#fff;',
        function () {
          startBtn.disabled = true;
          startBtn.textContent = 'Starte...';
          apiMethod('custom_helpdesk.python_scripts.billing.portal_api.start_timer', {
            ticket_name: ticketId,
          }).then(function () { renderBoth(ticketId); });
        }
      );

      btnRow.appendChild(startBtn);
      body.appendChild(btnRow);

      // Time logs table
      if (logs.length) {
        var table = el('table', 'width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px;');
        table.innerHTML =
          '<thead><tr style="border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;">' +
            '<th style="text-align:center;padding:4px 6px;width:24px;" title="Auswählen für Buchen"></th>' +
            '<th style="text-align:left;padding:4px 8px;">Start</th>' +
            '<th style="text-align:left;padding:4px 8px;">Ende</th>' +
            '<th style="text-align:right;padding:4px 8px;">Eff. (h)</th>' +
            '<th style="text-align:center;padding:4px 8px;">× Mult.</th>' +
            '<th style="text-align:left;padding:4px 8px;">Preiskategorie</th>' +
            '<th style="text-align:right;padding:4px 8px;">Gesamt (h)</th>' +
            '<th style="text-align:left;padding:4px 8px;">Mitarbeiter</th>' +
            '<th style="text-align:left;padding:4px 8px;">Projekt</th>' +
            '<th style="text-align:center;padding:4px 8px;">Rücksprache</th>' +
            '<th style="padding:4px 8px;">Status</th>' +
          '</tr></thead><tbody></tbody>';

        var tbody = table.querySelector('tbody');

        logs.forEach(function (row) {
          var eff = parseFloat(row.effective_duration) || parseFloat(row.duration) || 0;
          var mult = parseInt(row.multiplier) || 1;
          var total = eff * mult;
          var pc = pcMap[row.price_category];
          var pcLabel = pc ? (pc.time_code + ' – ' + pc.category_name) : (row.price_category || '–');

          var tr = el('tr', 'border-bottom:1px solid #f3f4f6;' + (row.gesperrt || row.is_invoiced ? 'color:#9ca3af;' : ''));

          var statusCell = document.createElement('td');
          statusCell.style.padding = '4px 8px';
          if (row.is_invoiced) {
            statusCell.appendChild(badge('Abgerechnet', '#d1fae5', '#065f46'));
          } else if (row.gesperrt) {
            statusCell.appendChild(badge('Gesperrt', '#fee2e2', '#991b1b'));
          } else {
            statusCell.appendChild(badge('Offen', '#fef3c7', '#92400e'));
          }

          if (row.gesperrt || row.is_invoiced) {
            // Locked / invoiced row — read-only display
            tr.innerHTML =
              '<td style="text-align:center;padding:4px 6px;"></td>' +
              '<td style="padding:4px 8px;">' + fmtDT(row.start_time) + '</td>' +
              '<td style="padding:4px 8px;">' + (row.end_time ? fmtDT(row.end_time) : '...') + '</td>' +
              '<td style="text-align:right;padding:4px 8px;">' + eff.toFixed(2) + '</td>' +
              '<td style="text-align:center;padding:4px 8px;">' + mult + '</td>' +
              '<td style="padding:4px 8px;">' + pcLabel + '</td>' +
              '<td style="text-align:right;padding:4px 8px;">' + total.toFixed(2) + '</td>' +
              '<td style="padding:4px 8px;">' + (row.staff_member || '–') + '</td>' +
              '<td style="padding:4px 8px;color:#374151;font-size:12px;">' + (function() { var p = projects.find(function(x){ return x.name === row.project; }); return _escHtml(p ? p.project_name : (row.project || '–')); })() + '</td>' +
              '<td style="text-align:center;padding:4px 8px;color:' + (row.ruecksprache_erforderlich ? '#d97706' : 'inherit') + ';">' + (row.ruecksprache_erforderlich ? '✓' : '') + '</td>';
            tr.appendChild(statusCell);
            tbody.appendChild(tr);
            // F5 — show description below locked row if present
            if (row.description) {
              var descTrL = el('tr', 'background:#f9fafb;');
              descTrL.innerHTML = '<td colspan="11" style="padding:2px 8px 6px 36px;color:#6b7280;font-size:12px;font-style:italic;">' +
                _escHtml(row.description) + '</td>';
              tbody.appendChild(descTrL);
            }
          } else {
            // Editable (unlocked) row
            var pcOptions = priceCats.map(function (p) {
              return '<option value="' + p.name + '"' + (p.name === row.price_category ? ' selected' : '') + '>' +
                p.time_code + ' – ' + p.category_name + '</option>';
            }).join('');

            var multOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function (v) {
              return '<option value="' + v + '"' + (v === mult ? ' selected' : '') + '>' + v + '</option>';
            }).join('');

            var staffSelect =
              '<select class="ch-staff" data-row="' + row.name + '" ' +
              'style="border:1px solid #d1d5db;border-radius:3px;padding:2px;max-width:160px;">' +
              '<option value="">– wählen –</option>' +
              agents.map(function (a) {
                return '<option value="' + a.name + '"' +
                  (a.name === row.staff_member ? ' selected' : '') + '>' +
                  _escHtml(a.agent_name || a.name) + '</option>';
              }).join('') +
              '</select>';

            tr.innerHTML =
              // F9 — select checkbox (checked by default)
              '<td style="text-align:center;padding:4px 6px;">' +
                '<input type="checkbox" class="ch-select-row" data-row="' + row.name + '" checked ' +
                  'style="cursor:pointer;width:14px;height:14px;" title="Für Buchen auswählen">' +
              '</td>' +
              '<td style="padding:4px 8px;">' +
                '<input type="datetime-local" class="ch-start-time" data-row="' + row.name + '"' +
                ' value="' + (row.start_time || '').replace(' ', 'T').slice(0, 16) + '"' +
                ' style="border:1px solid #d1d5db;border-radius:3px;padding:2px;font-size:12px;width:160px;">' +
              '</td>' +
              '<td style="padding:4px 8px;">' + (row.end_time ?
                '<input type="datetime-local" class="ch-end-time" data-row="' + row.name + '"' +
                ' value="' + (row.end_time || '').replace(' ', 'T').slice(0, 16) + '"' +
                ' style="border:1px solid #d1d5db;border-radius:3px;padding:2px;font-size:12px;width:160px;">'
                :
                '<span class="ch-live-elapsed" data-start-ms="' +
                  new Date((row.start_time || '').replace(' ', 'T')).getTime() +
                  '" style="font-weight:bold;color:#10b981;font-size:12px;">...</span>' +
                ' <button class="ch-stop-row" data-row="' + row.name +
                  '" style="padding:2px 6px;font-size:11px;background:#ef4444;color:#fff;' +
                  'border:none;border-radius:3px;cursor:pointer;margin-left:4px;">⏹ Stop</button>'
              ) + '</td>' +
              // F2 — effective duration shown above, manual override input below
              '<td style="text-align:right;padding:4px 8px;">' +
                '<span class="ch-eff-' + row.name + '" style="display:block;font-size:12px;color:#374151;">' + eff.toFixed(2) + '</span>' +
                '<input type="number" class="ch-manual" data-row="' + row.name + '" step="0.01" min="0" ' +
                  'style="width:60px;border:1px solid #d1d5db;border-radius:3px;padding:2px;font-size:12px;" ' +
                  'placeholder="Override" title="Manueller Override (h)" value="' + (row.manual_override || '') + '">' +
              '</td>' +
              '<td style="text-align:center;padding:4px 8px;">' +
                '<select class="ch-mult" data-row="' + row.name + '" style="width:50px;border:1px solid #d1d5db;border-radius:3px;padding:2px;">' + multOptions + '</select>' +
              '</td>' +
              '<td style="padding:4px 8px;">' +
                '<select class="ch-pc" data-row="' + row.name + '" style="border:1px solid #d1d5db;border-radius:3px;padding:2px;max-width:200px;">' +
                  '<option value="">– wählen –</option>' + pcOptions +
                '</select>' +
              '</td>' +
              '<td style="text-align:right;padding:4px 8px;" class="ch-tot-' + row.name + '">' + total.toFixed(2) + '</td>' +
              '<td style="padding:4px 8px;">' + staffSelect + '</td>' +
              '<td style="padding:4px 8px;">' +
                '<select class="ch-project" data-row="' + row.name + '" style="border:1px solid #d1d5db;border-radius:3px;padding:2px;max-width:160px;">' +
                '<option value="">– wählen –</option>' +
                projects.map(function (p) {
                  return '<option value="' + _escHtml(p.name) + '"' +
                    (p.name === row.project ? ' selected' : '') + '>' +
                    _escHtml(p.project_name || p.name) + '</option>';
                }).join('') +
                '</select>' +
              '</td>' +
              '<td style="text-align:center;padding:4px 8px;">' +
                '<input type="checkbox" class="ch-rueck" data-row="' + row.name + '"' + (row.ruecksprache_erforderlich ? ' checked' : '') + ' style="cursor:pointer;width:16px;height:16px;">' +
              '</td>';
            tr.appendChild(statusCell);

            // F8 — per-row Stop button for running rows
            var stopRowBtn = tr.querySelector('.ch-stop-row');
            if (stopRowBtn) {
              stopRowBtn.addEventListener('click', function () {
                stopRowBtn.disabled = true;
                stopRowBtn.textContent = '...';
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.stop_timer', {
                  ticket_name: ticketId,
                  row_name: stopRowBtn.dataset.row,
                }).then(function () { renderBoth(ticketId); });
              });
            }

            // Editable start / end time inputs
            var startInput = tr.querySelector('.ch-start-time');
            if (startInput) {
              startInput.addEventListener('change', function () {
                var val = startInput.value ? startInput.value + ':00' : '';
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_time_log', {
                  ticket_name: ticketId,
                  row_name: startInput.dataset.row,
                  data: JSON.stringify({ start_time: val.replace('T', ' ') }),
                }).then(function () { renderBoth(ticketId); });
              });
            }

            var endInput = tr.querySelector('.ch-end-time');
            if (endInput) {
              endInput.addEventListener('change', function () {
                var val = endInput.value ? endInput.value + ':00' : '';
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_time_log', {
                  ticket_name: ticketId,
                  row_name: endInput.dataset.row,
                  data: JSON.stringify({ end_time: val.replace('T', ' ') }),
                }).then(function () { renderBoth(ticketId); });
              });
            }

            // Staff member dropdown
            var staffSel = tr.querySelector('.ch-staff');
            if (staffSel) {
              staffSel.addEventListener('change', function () {
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_time_log', {
                  ticket_name: ticketId,
                  row_name: staffSel.dataset.row,
                  data: JSON.stringify({ staff_member: staffSel.value }),
                });
              });
            }

            // Project input
            var projSel = tr.querySelector('.ch-project');
            if (projSel) {
              projSel.addEventListener('change', function () {
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_time_log', {
                  ticket_name: ticketId,
                  row_name: projSel.dataset.row,
                  data: JSON.stringify({ project: projSel.value }),
                });
              });
            }

            // Save on change for multiplier and price category
            tr.querySelectorAll('.ch-mult, .ch-pc').forEach(function (sel) {
              sel.addEventListener('change', function () {
                var rowName = sel.dataset.row;
                var newMult = parseInt(tr.querySelector('.ch-mult').value) || 1;
                var newPc = tr.querySelector('.ch-pc').value;
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_time_log', {
                  ticket_name: ticketId,
                  row_name: rowName,
                  data: JSON.stringify({ multiplier: String(newMult), price_category: newPc }),
                }).then(function (res) {
                  if (res.message) {
                    var newEff = parseFloat(res.message.effective_duration) || 0;
                    var newTotal = newEff * newMult;
                    var effCell = table.querySelector('.ch-eff-' + rowName);
                    var totCell = table.querySelector('.ch-tot-' + rowName);
                    if (effCell) effCell.textContent = newEff.toFixed(2);
                    if (totCell) totCell.textContent = newTotal.toFixed(2);
                    renderBoth(ticketId);
                  }
                });
              });
            });

            // F2 — manual override handler
            var manualInput = tr.querySelector('.ch-manual');
            if (manualInput) {
              manualInput.addEventListener('change', function () {
                var val = parseFloat(manualInput.value);
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_time_log', {
                  ticket_name: ticketId,
                  row_name: manualInput.dataset.row,
                  data: JSON.stringify({ manual_override: isNaN(val) ? 0 : val }),
                }).then(function () { renderBoth(ticketId); });
              });
            }

            // Rücksprache checkbox handler
            var rueckChk = tr.querySelector('.ch-rueck');
            if (rueckChk) {
              rueckChk.addEventListener('change', function () {
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_time_log', {
                  ticket_name: ticketId,
                  row_name: rueckChk.dataset.row,
                  data: JSON.stringify({ ruecksprache_erforderlich: rueckChk.checked ? 1 : 0 }),
                });
              });
            }

            tbody.appendChild(tr);

            // F5 — description input sub-row for editable rows
            var descTrE = el('tr', 'background:#fafafa;border-bottom:1px solid #f0f0f0;');
            var descTd = el('td', 'padding:2px 8px 6px 36px;');
            descTd.setAttribute('colspan', '11');
            var descInput = document.createElement('textarea');
            descInput.rows = 1;
            descInput.style.cssText = 'width:100%;border:1px solid #e5e7eb;border-radius:3px;padding:3px 6px;font-size:12px;box-sizing:border-box;resize:none;overflow:hidden;line-height:1.4;font-family:inherit;';
            descInput.placeholder = 'Beschreibung (was wurde gemacht?)';
            descInput.value = row.description || '';
            descInput.dataset.row = row.name;
            descInput.addEventListener('input', function () {
              this.style.height = 'auto';
              this.style.height = this.scrollHeight + 'px';
            });
            descInput.style.height = 'auto';
            descInput.style.height = (descInput.scrollHeight || 24) + 'px';
            descInput.addEventListener('change', function () {
              apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_time_log', {
                ticket_name: ticketId,
                row_name: descInput.dataset.row,
                data: JSON.stringify({ description: descInput.value }),
              });
            });
            descTd.appendChild(descInput);
            descTrE.appendChild(descTd);
            tbody.appendChild(descTrE);
          }
        });

        body.appendChild(table);
      } else {
        var empty = el('p', 'color:#9ca3af;font-size:13px;margin-bottom:12px;');
        empty.textContent = 'Noch keine Zeiteinträge.';
        body.appendChild(empty);
      }

      // F9 — Buchen button submits only checked rows
      if (hasBookable) {
        var buchenBtn = btn(
          'Buchen → ERPNext Timesheet',
          'border:1px solid #3b82f6;background:#3b82f6;color:#fff;margin-top:4px;',
          function () {
            var checkboxes = panel.querySelectorAll('.ch-select-row:checked');
            var selectedRows = Array.prototype.map.call(checkboxes, function (cb) { return cb.dataset.row; });
            if (!selectedRows.length) {
              alert('Keine Zeilen ausgewählt. Bitte mindestens eine Zeile ankreuzen.');
              return;
            }
            if (!confirm('Ausgewählte Zeiteinträge (' + selectedRows.length + ') als ERPNext Timesheet buchen?')) return;
            buchenBtn.disabled = true;
            buchenBtn.textContent = 'Buche...';
            apiMethod('custom_helpdesk.python_scripts.billing.buchen.buchen', {
              ticket_name: ticketId,
              row_names: JSON.stringify(selectedRows),
            }).then(function (res) {
              if (res.message) {
                alert('Timesheet ' + res.message + ' wurde erstellt.');
                renderBoth(ticketId);
              } else {
                var err = (res.exception || res._server_messages || 'Unbekannter Fehler');
                alert('Fehler: ' + err);
                buchenBtn.disabled = false;
                buchenBtn.textContent = 'Buchen → ERPNext Timesheet';
              }
            });
          }
        );
        body.appendChild(buchenBtn);
      }

      // Buchen history
      return apiMethod('custom_helpdesk.python_scripts.billing.buchen.get_buchen_history', {
        ticket_name: ticketId,
      }).then(function (histRes) {
        var hist = (histRes && histRes.message) || [];
        if (hist.length) {
          var histDiv = el('div', 'margin-top:16px;font-size:13px;');
          var histTitle = el('strong', '');
          histTitle.textContent = 'Buchungshistorie';
          histDiv.appendChild(histTitle);

          var htable = el('table', 'width:100%;border-collapse:collapse;margin-top:8px;font-size:13px;');
          htable.innerHTML =
            '<thead><tr style="color:#6b7280;font-size:12px;border-bottom:1px solid #e5e7eb;">' +
              '<th style="text-align:left;padding:4px 8px;">Datum</th>' +
              '<th style="text-align:left;padding:4px 8px;">Timesheet</th>' +
              '<th style="text-align:right;padding:4px 8px;">Stunden</th>' +
            '</tr></thead><tbody>' +
            hist.map(function (h) {
              return '<tr style="border-bottom:1px solid #f3f4f6;">' +
                '<td style="padding:4px 8px;">' + fmtDT(h.buchen_timestamp) + '</td>' +
                '<td style="padding:4px 8px;"><a href="/app/timesheet/' + h.timesheet + '" target="_blank">' + h.timesheet + '</a></td>' +
                '<td style="text-align:right;padding:4px 8px;">' + (parseFloat(h.total_hours) || 0).toFixed(2) + ' h</td>' +
              '</tr>';
            }).join('') +
            '</tbody>';
          histDiv.appendChild(htable);
          body.appendChild(histDiv);
        }

        // Collapse toggle
        var collapsed = false;
        header.onclick = function () {
          collapsed = !collapsed;
          body.style.display = collapsed ? 'none' : 'block';
          arrow.textContent = collapsed ? '▶' : '▼';
        };

        panel.appendChild(header);
        panel.appendChild(body);

        _insertPanel(panel);

        // F4 — watch for Vue removing our panel (tab switches between Activity/Emails/Comments)
        watchForPanelRemoval(ticketId);

        // F8 — single interval updates live counters for all running rows in the panel
        var hasRunning = logs.some(function (r) { return r.start_time && !r.end_time; });
        if (hasRunning) {
          _timerInterval = setInterval(function () {
            var p = document.getElementById(PANEL_ID);
            if (!p) { clearInterval(_timerInterval); _timerInterval = null; return; }
            p.querySelectorAll('.ch-live-elapsed').forEach(function (span) {
              var startMs = parseInt(span.dataset.startMs, 10);
              if (startMs) {
                span.textContent = ((Date.now() - startMs) / 3600000).toFixed(4) + ' h';
              }
            });
          }, 1000);
        }
      });
    }).catch(function (err) {
      console.error('[custom_helpdesk] Zeiterfassung panel error:', err);
    });
  }

  // ── Agent Verwendete Artikel panel ─────────────────────────────────────────

  function renderItemsPanel(ticketId) {
    return getTicketItems(ticketId).then(function (items) {
      var existingPanel = document.getElementById(ITEMS_PANEL_ID);
      if (existingPanel) existingPanel.remove();

      var submittedCount = items.filter(function (i) { return i.is_submitted; }).length;

      var panel = el('div', 'margin:0 20px 20px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-family:inherit;font-size:14px;');
      panel.id = ITEMS_PANEL_ID;

      // Header
      var header = el('div', 'padding:12px 16px;border-bottom:1px solid #d1d5db;display:flex;align-items:center;gap:12px;cursor:pointer;');
      var headerTitle = el('strong', 'font-size:14px;');
      headerTitle.textContent = 'Verwendete Artikel';
      var headerStats = el('span', 'font-size:13px;color:#6b7280;');
      headerStats.textContent = items.length + ' Artikel · ' + submittedCount + ' übertragen';
      var arrow = el('span', 'margin-left:auto;');
      arrow.textContent = '▼';
      header.appendChild(headerTitle);
      header.appendChild(headerStats);
      header.appendChild(arrow);

      // Body
      var body = el('div', 'padding:12px 16px;');

      if (items.length) {
        var table = el('table', 'width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px;');
        table.innerHTML =
          '<thead><tr style="border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;">' +
            '<th style="text-align:left;padding:4px 8px;">Artikel</th>' +
            '<th style="text-align:left;padding:4px 8px;">Artikelname</th>' +
            '<th style="text-align:right;padding:4px 8px;">Menge</th>' +
            '<th style="text-align:left;padding:4px 8px;">Einheit</th>' +
            '<th style="text-align:center;padding:4px 8px;">Status</th>' +
            '<th style="text-align:center;padding:4px 8px;">Aktionen</th>' +
          '</tr></thead><tbody></tbody>';

        var tbody = table.querySelector('tbody');

        items.forEach(function (row) {
          var tr = el('tr', 'border-bottom:1px solid #f3f4f6;');
          if (row.is_submitted) {
            var statusTd = el('td', 'text-align:center;padding:4px 8px;');
            statusTd.appendChild(badge('Übertragen', '#d1fae5', '#065f46'));
            tr.innerHTML =
              '<td style="padding:4px 8px;color:#9ca3af;">' + _escHtml(row.item_code || '') + '</td>' +
              '<td style="padding:4px 8px;color:#9ca3af;">' + _escHtml(row.item_name || '') + '</td>' +
              '<td style="text-align:right;padding:4px 8px;color:#9ca3af;">' + (parseFloat(row.qty) || 0) + '</td>' +
              '<td style="padding:4px 8px;color:#9ca3af;">' + _escHtml(row.uom || '') + '</td>';
            tr.appendChild(statusTd);
            tr.appendChild(el('td', 'text-align:center;padding:4px 8px;'));
          } else {
            var qtyInput = el('input', 'width:60px;border:1px solid #d1d5db;border-radius:3px;padding:2px 4px;font-size:13px;text-align:right;');
            qtyInput.type = 'number';
            qtyInput.min = '0.01';
            qtyInput.step = '0.01';
            qtyInput.value = row.qty || 1;

            var uomInput = el('input', 'width:80px;border:1px solid #d1d5db;border-radius:3px;padding:2px 4px;font-size:13px;');
            uomInput.type = 'text';
            uomInput.value = row.uom || '';

            var delBtn = btn('🗑', 'border:1px solid #ef4444;background:#fff;color:#ef4444;padding:2px 6px;font-size:12px;', null);
            delBtn.title = 'Artikel löschen';

            var openStatusTd = el('td', 'text-align:center;padding:4px 8px;');
            openStatusTd.appendChild(badge('Offen', '#fef3c7', '#92400e'));
            var qtyTd = el('td', 'text-align:right;padding:4px 8px;');
            qtyTd.appendChild(qtyInput);
            var uomTd = el('td', 'padding:4px 8px;');
            uomTd.appendChild(uomInput);
            var actionsTd = el('td', 'text-align:center;padding:4px 8px;');
            actionsTd.appendChild(delBtn);

            tr.innerHTML =
              '<td style="padding:4px 8px;">' + _escHtml(row.item_code || '') + '</td>' +
              '<td style="padding:4px 8px;color:#6b7280;">' + _escHtml(row.item_name || '') + '</td>';
            tr.appendChild(qtyTd);
            tr.appendChild(uomTd);
            tr.appendChild(openStatusTd);
            tr.appendChild(actionsTd);

            (function (rowName, qtyEl, uomEl, dBtn) {
              qtyEl.addEventListener('change', function () {
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_ticket_item', {
                  ticket_name: ticketId,
                  row_name: rowName,
                  data: JSON.stringify({ qty: parseFloat(qtyEl.value) || 1 }),
                }).then(function () { renderItemsPanel(ticketId); });
              });
              uomEl.addEventListener('change', function () {
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.update_ticket_item', {
                  ticket_name: ticketId,
                  row_name: rowName,
                  data: JSON.stringify({ uom: uomEl.value }),
                }).then(function () { renderItemsPanel(ticketId); });
              });
              dBtn.addEventListener('click', function () {
                if (!confirm('Artikel löschen?')) return;
                apiMethod('custom_helpdesk.python_scripts.billing.portal_api.delete_ticket_item', {
                  ticket_name: ticketId,
                  row_name: rowName,
                }).then(function () { renderItemsPanel(ticketId); });
              });
            })(row.name, qtyInput, uomInput, delBtn);
          }
          tbody.appendChild(tr);
        });

        body.appendChild(table);
      } else {
        var emptyP = el('p', 'color:#9ca3af;font-size:13px;margin-bottom:12px;');
        emptyP.textContent = 'Noch keine Artikel erfasst.';
        body.appendChild(emptyP);
      }

      // Add item form
      var addForm = el('div', 'display:flex;gap:8px;align-items:flex-start;flex-wrap:nowrap;margin-top:8px;padding-top:12px;border-top:1px solid #f0f0f0;');

      var itemCodeWrap = el('div', 'display:flex;flex-direction:column;gap:2px;');
      var itemCodeInput = el('input', 'border:1px solid #d1d5db;border-radius:3px;padding:4px 8px;font-size:13px;width:160px;');
      itemCodeInput.type = 'text';
      itemCodeInput.placeholder = 'Artikel-Code';

      var itemNameSpan = el('span', 'font-size:11px;color:#6b7280;');
      itemCodeWrap.appendChild(itemCodeInput);
      itemCodeWrap.appendChild(itemNameSpan);

      var addQtyInput = el('input', 'width:70px;border:1px solid #d1d5db;border-radius:3px;padding:4px 8px;font-size:13px;');
      addQtyInput.type = 'number';
      addQtyInput.min = '0.01';
      addQtyInput.step = '0.01';
      addQtyInput.value = '1';
      addQtyInput.placeholder = 'Menge';

      var addUomInput = el('input', 'width:80px;border:1px solid #d1d5db;border-radius:3px;padding:4px 8px;font-size:13px;');
      addUomInput.type = 'text';
      addUomInput.placeholder = 'Einheit';

      var addItemBtn = btn('＋ Hinzufügen', 'border:1px solid #3b82f6;background:#3b82f6;color:#fff;', null);

      // Validate item_code on blur and auto-fill item_name + uom
      itemCodeInput.addEventListener('blur', function () {
        var code = itemCodeInput.value.trim();
        if (!code) { itemNameSpan.textContent = ''; return; }
        apiFetch('/api/resource/Item/' + encodeURIComponent(code))
          .then(function (res) {
            if (res.data) {
              itemNameSpan.textContent = res.data.item_name || code;
              itemCodeInput.style.borderColor = '#d1d5db';
              if (!addUomInput.value) addUomInput.value = res.data.stock_uom || '';
            } else {
              itemNameSpan.textContent = '(nicht gefunden)';
              itemCodeInput.style.borderColor = '#ef4444';
            }
          }).catch(function () {
            itemNameSpan.textContent = '(nicht gefunden)';
            itemCodeInput.style.borderColor = '#ef4444';
          });
      });

      addItemBtn.addEventListener('click', function () {
        var code = itemCodeInput.value.trim();
        if (!code) { itemCodeInput.style.borderColor = '#ef4444'; itemCodeInput.focus(); return; }
        addItemBtn.disabled = true;
        addItemBtn.textContent = '...';
        apiMethod('custom_helpdesk.python_scripts.billing.portal_api.add_ticket_item', {
          ticket_name: ticketId,
          data: JSON.stringify({ item_code: code, qty: parseFloat(addQtyInput.value) || 1, uom: addUomInput.value.trim() }),
        }).then(function (res) {
          if (res.message) {
            renderItemsPanel(ticketId);
          } else {
            alert('Fehler: ' + (res.exception || res._server_messages || 'Unbekannter Fehler'));
            addItemBtn.disabled = false;
            addItemBtn.textContent = '＋ Hinzufügen';
          }
        }).catch(function () {
          addItemBtn.disabled = false;
          addItemBtn.textContent = '＋ Hinzufügen';
        });
      });

      addForm.appendChild(itemCodeWrap);
      addForm.appendChild(addQtyInput);
      addForm.appendChild(addUomInput);
      addForm.appendChild(addItemBtn);
      body.appendChild(addForm);

      // Collapse toggle
      var collapsed = false;
      header.onclick = function () {
        collapsed = !collapsed;
        body.style.display = collapsed ? 'none' : 'block';
        arrow.textContent = collapsed ? '▶' : '▼';
      };

      panel.appendChild(header);
      panel.appendChild(body);
      _insertPanel(panel);
    }).catch(function (err) {
      console.error('[custom_helpdesk] Items panel error:', err);
    });
  }

  // ── HD Termine panel ───────────────────────────────────────────────────────

  function renderTerminePanel(ticketId) {
    apiMethod(
      'custom_helpdesk.python_scripts.termine.termine_api.get_termine',
      { ticket_name: ticketId }
    ).then(function (res) {
      var termine = res.message || [];

      var existing = document.getElementById(TERMINE_PANEL_ID);
      if (existing) existing.remove();

      var panel = el('div', 'margin:0 20px 20px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-family:inherit;font-size:14px;');
      panel.id = TERMINE_PANEL_ID;

      // Header
      var header = el('div', 'padding:12px 16px;border-bottom:1px solid #d1d5db;display:flex;align-items:center;gap:12px;cursor:pointer;');
      var headerTitle = el('strong', 'font-size:14px;');
      headerTitle.textContent = 'Termine';
      var headerStats = el('span', 'font-size:13px;color:#6b7280;');
      headerStats.textContent = termine.length + ' Termin(e)';
      var kalLink = el('a', 'margin-left:8px;font-size:12px;color:#6366f1;text-decoration:none;');
      kalLink.href = '/helpdesk-kalender';
      kalLink.target = '_blank';
      kalLink.textContent = '📅 Kalender öffnen';
      kalLink.onclick = function (e) { e.stopPropagation(); };
      var arrow = el('span', 'margin-left:auto;');
      arrow.textContent = '▼';
      header.appendChild(headerTitle);
      header.appendChild(headerStats);
      header.appendChild(kalLink);
      header.appendChild(arrow);

      var body = el('div', 'padding:12px 16px;');

      // Existing termine list
      if (termine.length) {
        var tList = el('div', 'margin-bottom:12px;');
        termine.forEach(function (t) {
          var color = TERMIN_COLORS[t.type] || '#607D8B';
          var row = el('div',
            'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;' +
            'border:1px solid #e5e7eb;margin-bottom:6px;background:#fafafa;font-size:13px;'
          );

          var dot = el('span',
            'width:10px;height:10px;border-radius:50%;flex-shrink:0;background:' + color + ';'
          );
          row.appendChild(dot);

          var typeBadge = el('span',
            'padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;' +
            'color:#fff;background:' + color + ';white-space:nowrap;flex-shrink:0;'
          );
          typeBadge.textContent = t.type;
          row.appendChild(typeBadge);

          var timeSpan = el('span', 'color:#374151;white-space:nowrap;');
          timeSpan.textContent = fmtDT(t.from_time) + ' – ' + fmtDT(t.to_time);
          row.appendChild(timeSpan);

          if (t.description) {
            var descSpan = el('span', 'color:#6b7280;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
            descSpan.textContent = t.description;
            row.appendChild(descSpan);
          } else {
            row.appendChild(el('span', 'flex:1;'));
          }

          if (t.assigned_to) {
            var assignSpan = el('span', 'color:#6b7280;font-size:12px;white-space:nowrap;');
            assignSpan.textContent = t.assigned_to.split('@')[0];
            row.appendChild(assignSpan);
          }

          var editRowBtn = el('button',
            'border:1px solid #6366f1;background:#fff;color:#6366f1;border-radius:4px;' +
            'padding:2px 6px;font-size:11px;cursor:pointer;flex-shrink:0;',
            {}
          );
          editRowBtn.textContent = '✎';
          editRowBtn.title = 'Termin bearbeiten';
          (function (termin) {
            editRowBtn.addEventListener('click', function () { activateEditMode(termin); });
          })(t);
          row.appendChild(editRowBtn);

          var delBtn = el('button',
            'border:1px solid #ef4444;background:#fff;color:#ef4444;border-radius:4px;' +
            'padding:2px 6px;font-size:11px;cursor:pointer;flex-shrink:0;',
            {}
          );
          delBtn.textContent = '✕';
          delBtn.title = 'Termin löschen';
          (function (terminName) {
            delBtn.addEventListener('click', function () {
              if (!confirm('Termin löschen?')) return;
              apiMethod(
                'custom_helpdesk.python_scripts.termine.termine_api.delete_termin',
                { termin_name: terminName }
              ).then(function () { renderTerminePanel(ticketId); });
            });
          })(t.name);
          row.appendChild(delBtn);

          tList.appendChild(row);
        });
        body.appendChild(tList);
      } else {
        var emptyP = el('p', 'color:#9ca3af;font-size:13px;margin-bottom:12px;');
        emptyP.textContent = 'Noch keine Termine für dieses Ticket.';
        body.appendChild(emptyP);
      }

      // ── New / Edit Termin inline form ──
      var editingTerminName = null;

      var formWrap = el('div', 'border-top:1px solid #f0f0f0;padding-top:12px;');

      var formHeaderRow = el('div', 'display:flex;align-items:center;gap:10px;margin-bottom:8px;');
      var formTitle = el('strong', 'font-size:13px;color:#374151;');
      formTitle.textContent = '+ Neuer Termin';
      var cancelEditBtn = el('button',
        'font-size:11px;border:1px solid #d1d5db;background:#fff;color:#6b7280;' +
        'border-radius:4px;padding:2px 8px;cursor:pointer;display:none;',
        {}
      );
      cancelEditBtn.textContent = 'Abbrechen';
      formHeaderRow.appendChild(formTitle);
      formHeaderRow.appendChild(cancelEditBtn);
      formWrap.appendChild(formHeaderRow);

      var formGrid = el('div', 'display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;');

      function fld(labelText, inputEl) {
        var wrap = el('div', 'display:flex;flex-direction:column;gap:2px;');
        var lbl = el('label', 'font-size:11px;color:#6b7280;');
        lbl.textContent = labelText;
        wrap.appendChild(lbl);
        wrap.appendChild(inputEl);
        return wrap;
      }

      var typeSel = el('select', 'border:1px solid #d1d5db;border-radius:4px;padding:4px 6px;font-size:13px;');
      ['', 'Notdienst', 'Urlaub', 'Home Office', 'Außer Haus', 'Remote-Inhouse'].forEach(function (v) {
        var o = el('option', ''); o.value = v; o.textContent = v || '– Typ –';
        typeSel.appendChild(o);
      });
      formGrid.appendChild(fld('Typ *', typeSel));

      var fromInput = el('input', 'border:1px solid #d1d5db;border-radius:4px;padding:4px 6px;font-size:13px;');
      fromInput.type = 'datetime-local';
      formGrid.appendChild(fld('Von *', fromInput));

      var toInput = el('input', 'border:1px solid #d1d5db;border-radius:4px;padding:4px 6px;font-size:13px;');
      toInput.type = 'datetime-local';
      formGrid.appendChild(fld('Bis *', toInput));

      var descInput = el('input', 'border:1px solid #d1d5db;border-radius:4px;padding:4px 6px;font-size:13px;width:180px;');
      descInput.type = 'text';
      descInput.placeholder = 'Beschreibung';
      formGrid.appendChild(fld('Beschreibung', descInput));

      // 2.2 Smart agent select instead of free-text email
      var assignedSel = el('select', 'border:1px solid #d1d5db;border-radius:4px;padding:4px 6px;font-size:13px;width:160px;');
      var assignedSelEmpty = el('option', ''); assignedSelEmpty.value = ''; assignedSelEmpty.textContent = '– Mitarbeiter –';
      assignedSel.appendChild(assignedSelEmpty);
      getAgents().then(function (agents) {
        agents.forEach(function (a) {
          var o = el('option', ''); o.value = a.user; o.textContent = a.agent_name || a.user;
          assignedSel.appendChild(o);
        });
      });
      formGrid.appendChild(fld('Zugewiesen an', assignedSel));

      var addBtn = btn('Speichern',
        'border:1px solid #6366f1;background:#6366f1;color:#fff;align-self:flex-end;',
        function () {
          if (!typeSel.value) { typeSel.style.borderColor = '#ef4444'; typeSel.focus(); return; }
          if (!fromInput.value) { fromInput.style.borderColor = '#ef4444'; fromInput.focus(); return; }
          if (!toInput.value) { toInput.style.borderColor = '#ef4444'; toInput.focus(); return; }

          addBtn.disabled = true;
          addBtn.textContent = '…';

          var payload = {
            type: typeSel.value,
            from_time: fromInput.value.replace('T', ' ') + ':00',
            to_time: toInput.value.replace('T', ' ') + ':00',
            description: descInput.value,
            assigned_to: assignedSel.value,
            ticket: ticketId,
          };

          if (editingTerminName) {
            // 2.5 Update existing via proper update_termin endpoint
            apiMethod(
              'custom_helpdesk.python_scripts.termine.termine_api.update_termin',
              { termin_name: editingTerminName, data: JSON.stringify(payload) }
            ).then(function (res) {
              if (res.exc) {
                alert('Fehler beim Speichern.');
                addBtn.disabled = false;
                addBtn.textContent = 'Aktualisieren';
                return;
              }
              renderTerminePanel(ticketId);
            });
          } else {
            apiMethod(
              'custom_helpdesk.python_scripts.termine.termine_api.add_termin',
              { data: JSON.stringify(payload) }
            ).then(function (res) {
              if (res.message) {
                renderTerminePanel(ticketId);
              } else {
                alert('Fehler: ' + (res.exception || res._server_messages || 'Unbekannter Fehler'));
                addBtn.disabled = false;
                addBtn.textContent = 'Speichern';
              }
            });
          }
        }
      );
      formGrid.appendChild(addBtn);

      function activateEditMode(termin) {
        editingTerminName = termin.name;
        typeSel.value = termin.type || '';
        fromInput.value = termin.from_time ? String(termin.from_time).slice(0, 16).replace(' ', 'T') : '';
        toInput.value = termin.to_time ? String(termin.to_time).slice(0, 16).replace(' ', 'T') : '';
        descInput.value = termin.description || '';
        assignedSel.value = termin.assigned_to || '';
        formTitle.textContent = '✎ Termin bearbeiten';
        cancelEditBtn.style.display = '';
        addBtn.textContent = 'Aktualisieren';
        formWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }

      cancelEditBtn.addEventListener('click', function () {
        editingTerminName = null;
        typeSel.value = '';
        fromInput.value = '';
        toInput.value = '';
        descInput.value = '';
        assignedSel.value = '';
        formTitle.textContent = '+ Neuer Termin';
        cancelEditBtn.style.display = 'none';
        addBtn.textContent = 'Speichern';
        addBtn.disabled = false;
      });

      formWrap.appendChild(formGrid);
      body.appendChild(formWrap);

      // Collapse toggle
      var collapsed = false;
      header.onclick = function () {
        collapsed = !collapsed;
        body.style.display = collapsed ? 'none' : 'block';
        arrow.textContent = collapsed ? '▶' : '▼';
      };

      panel.appendChild(header);
      panel.appendChild(body);
      _insertPanel(panel);
    }).catch(function (err) {
      console.error('[custom_helpdesk] Termine panel error:', err);
    });
  }

  function _escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _insertPanel(panel) {
    // Prefer a recognizable content wrapper; fall back to #app
    var targets = [
      document.querySelector('.flex-1.overflow-y-auto'),
      document.querySelector('main'),
      document.querySelector('#app'),
    ];
    for (var i = 0; i < targets.length; i++) {
      if (targets[i]) {
        targets[i].appendChild(panel);
        return;
      }
    }
  }

  // ── Customer portal: closed ticket banner ───────────────────────────────────

  function handleCustomerPortal(ticketId) {
    renderCustomerTimeLogs(ticketId);
    return apiFetch('/api/resource/HD%20Ticket/' + encodeURIComponent(ticketId))
      .then(function (res) {
        var ticket = res.data;
        if (ticket && ticket.status === 'Geschlossen') {
          _showClosedBanner();
        }
      }).catch(function (err) {
        console.error('[custom_helpdesk] Customer portal check error:', err);
      });
  }

  function _showClosedBanner() {
    if (document.getElementById('ch-closed-banner')) return;

    var banner = el('div',
      'position:fixed;bottom:0;left:0;right:0;background:#fef2f2;border-top:2px solid #ef4444;' +
      'padding:12px 24px;color:#991b1b;font-size:14px;z-index:9999;text-align:center;'
    );
    banner.id = 'ch-closed-banner';
    banner.innerHTML =
      '🔒 Dieses Ticket ist geschlossen. Bitte ' +
      '<a href="/helpdesk/my-tickets/new" style="color:#1d4ed8;text-decoration:underline;">erstellen Sie ein neues Ticket</a>' +
      ' für weitere Anfragen.';
    document.body.appendChild(banner);

    // Disable reply inputs after Vue finishes rendering
    setTimeout(function () {
      document.querySelectorAll('textarea, [contenteditable="true"]').forEach(function (el) {
        el.setAttribute('disabled', 'true');
        el.style.backgroundColor = '#f3f4f6';
        el.style.cursor = 'not-allowed';
        el.style.pointerEvents = 'none';
      });
    }, 800);
  }

  // ── Customer Zeiterfassung (read-only) ─────────────────────────────────────

  function watchForCustomerPanelRemoval(ticketId) {
    if (_customerObserver) _customerObserver.disconnect();
    _customerObserver = new MutationObserver(function () {
      if (!document.getElementById(CUSTOMER_TIMES_ID)) {
        setTimeout(function () { renderCustomerTimeLogs(ticketId); }, 400);
      }
    });
    _customerObserver.observe(document.body, { childList: true, subtree: true });
  }

  function renderCustomerTimeLogs(ticketId) {
    Promise.all([getTimeLogs(ticketId), getPriceCategories()]).then(function (results) {
      var logs = results[0];
      var priceCats = results[1];
      var pcMap = {};
      priceCats.forEach(function (p) { pcMap[p.name] = p; });

      var existing = document.getElementById(CUSTOMER_TIMES_ID);
      if (existing) existing.remove();

      // Totals
      var totalH = 0;
      logs.forEach(function (r) {
        totalH += (parseFloat(r.effective_duration) || 0) * (parseInt(r.multiplier) || 1);
      });

      var panel = el('div', 'margin:20px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-family:inherit;font-size:14px;');
      panel.id = CUSTOMER_TIMES_ID;

      // Header
      var header = el('div', 'padding:12px 16px;border-bottom:1px solid #d1d5db;display:flex;align-items:center;gap:12px;cursor:pointer;');
      var headerTitle = el('strong', 'font-size:14px;');
      headerTitle.textContent = 'Zeiterfassung';
      var headerStats = el('span', 'font-size:13px;color:#6b7280;');
      headerStats.textContent = totalH.toFixed(2) + 'h gesamt';
      var arrow = el('span', 'margin-left:auto;');
      arrow.textContent = '▼';
      header.appendChild(headerTitle);
      header.appendChild(headerStats);
      header.appendChild(arrow);

      // Body
      var body = el('div', 'padding:12px 16px;');

      if (logs.length) {
        var table = el('table', 'width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px;');
        table.innerHTML =
          '<thead><tr style="border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;">' +
            '<th style="text-align:left;padding:4px 8px;">Start</th>' +
            '<th style="text-align:right;padding:4px 8px;">Eff. (h)</th>' +
            '<th style="text-align:left;padding:4px 8px;">Preiskategorie</th>' +
            '<th style="text-align:right;padding:4px 8px;">Gesamt (h)</th>' +
            '<th style="text-align:left;padding:4px 8px;">Mitarbeiter</th>' +
            '<th style="text-align:left;padding:4px 8px;">Projekt</th>' +
            '<th style="padding:4px 8px;">Status</th>' +
          '</tr></thead><tbody></tbody>';

        var tbody = table.querySelector('tbody');

        logs.forEach(function (row) {
          var eff = parseFloat(row.effective_duration) || parseFloat(row.duration) || 0;
          var mult = parseInt(row.multiplier) || 1;
          var total = eff * mult;
          var pc = pcMap[row.price_category];
          var pcLabel = pc ? (pc.time_code + ' – ' + pc.category_name) : (row.price_category || '–');

          var tr = el('tr', 'border-bottom:1px solid #f3f4f6;' + (row.gesperrt || row.is_invoiced ? 'color:#9ca3af;' : ''));

          var statusTd = document.createElement('td');
          statusTd.style.padding = '4px 8px';
          if (row.is_invoiced) {
            statusTd.appendChild(badge('Abgerechnet', '#d1fae5', '#065f46'));
          } else if (row.gesperrt) {
            statusTd.appendChild(badge('Gesperrt', '#fee2e2', '#991b1b'));
          } else {
            statusTd.appendChild(badge('Offen', '#fef3c7', '#92400e'));
          }

          tr.innerHTML =
            '<td style="padding:4px 8px;">' + fmtDT(row.start_time) + '</td>' +
            '<td style="text-align:right;padding:4px 8px;">' + eff.toFixed(2) + '</td>' +
            '<td style="padding:4px 8px;">' + _escHtml(pcLabel) + '</td>' +
            '<td style="text-align:right;padding:4px 8px;">' + total.toFixed(2) + '</td>' +
            '<td style="padding:4px 8px;">' + _escHtml(row.staff_member || '–') + '</td>' +
            '<td style="padding:4px 8px;">' + _escHtml(row.project || '–') + '</td>';
          tr.appendChild(statusTd);
          tbody.appendChild(tr);

          // Description sub-row
          if (row.description) {
            var descTr = el('tr', 'background:#f9fafb;');
            descTr.innerHTML = '<td colspan="7" style="padding:2px 8px 6px 24px;color:#6b7280;font-size:12px;font-style:italic;">' +
              _escHtml(row.description) + '</td>';
            tbody.appendChild(descTr);
          }
        });

        body.appendChild(table);
      } else {
        var empty = el('p', 'color:#9ca3af;font-size:13px;margin-bottom:8px;');
        empty.textContent = 'Noch keine Zeiteinträge.';
        body.appendChild(empty);
      }

      // Collapse toggle
      var collapsed = false;
      header.onclick = function () {
        collapsed = !collapsed;
        body.style.display = collapsed ? 'none' : 'block';
        arrow.textContent = collapsed ? '▶' : '▼';
      };

      panel.appendChild(header);
      panel.appendChild(body);
      _insertPanel(panel);

      watchForCustomerPanelRemoval(ticketId);

      // Show a floating scroll-hint button so the customer knows there is a
      // Zeiterfassung table below the reply area.
      var existingHint = document.getElementById('ch-times-hint');
      if (existingHint) existingHint.remove();
      var hint = document.createElement('div');
      hint.id = 'ch-times-hint';
      hint.style.cssText =
        'position:fixed;bottom:72px;right:16px;background:#3b82f6;color:#fff;' +
        'padding:8px 14px;border-radius:20px;font-size:13px;font-weight:500;' +
        'cursor:pointer;z-index:9998;box-shadow:0 2px 10px rgba(0,0,0,0.25);' +
        'display:flex;align-items:center;gap:6px;';
      hint.innerHTML = '&#8595; Zeiterfassung';
      hint.title = 'Klicken, um zur Zeiterfassung zu scrollen';
      hint.onclick = function () {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        hint.remove();
      };
      document.body.appendChild(hint);
      // Auto-hide after 10 seconds
      setTimeout(function () { if (hint.parentNode) hint.remove(); }, 10000);
    }).catch(function (err) {
      console.error('[custom_helpdesk] Customer times panel error:', err);
    });
  }

  // ── Closing dialog interceptor ──────────────────────────────────────────────

  function installClosingInterceptor() {
    if (_closingInterceptorInstalled) return;
    _closingInterceptorInstalled = true;
    document.addEventListener('click', function (e) {
      var item = e.target.closest('[role="menuitem"]');
      if (!item) return;
      var label = item.textContent.replace(/\s+/g, ' ').trim();
      if (!_closedStatusNames.has(label)) return;
      var ticketId = agentTicketId();
      if (!ticketId) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      // Close the Radix dropdown by simulating Escape
      setTimeout(function () {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true })
        );
      }, 0);
      showClosingDialog(ticketId, label);
    }, true); // capture phase
  }

  function showClosingDialog(ticketId, targetStatus) {
    var existing = document.getElementById('ch-closing-overlay');
    if (existing) existing.remove();

    var overlay = el('div',
      'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;' +
      'display:flex;align-items:center;justify-content:center;'
    );
    overlay.id = 'ch-closing-overlay';

    var dialog = el('div',
      'background:#fff;border-radius:10px;padding:24px;width:500px;max-width:95vw;' +
      'max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);'
    );

    var titleEl = el('h2', 'margin:0 0 8px;font-size:18px;font-weight:600;color:#111827;');
    titleEl.textContent = 'Ticket schließen';
    dialog.appendChild(titleEl);

    var statusBadge = el('p', 'margin:0 0 20px;font-size:13px;color:#6b7280;');
    statusBadge.innerHTML = 'Neuer Status: <strong style="color:#374151;">' + targetStatus + '</strong>';
    dialog.appendChild(statusBadge);

    function sep(text) {
      var s = el('div',
        'margin:16px 0 8px;font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;' +
        'letter-spacing:0.05em;border-top:1px solid #f3f4f6;padding-top:12px;'
      );
      s.textContent = text;
      return s;
    }

    // ── Pflichtfelder ──
    dialog.appendChild(sep('Pflichtfelder'));

    function makeCheckbox(id, labelText) {
      var wrap = el('label',
        'display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #e5e7eb;' +
        'border-radius:6px;cursor:pointer;margin-bottom:8px;font-size:14px;color:#374151;'
      );
      var cb = el('input', 'width:16px;height:16px;cursor:pointer;flex-shrink:0;margin:0;');
      cb.type = 'checkbox';
      cb.id = id;
      var lbl = el('span', '');
      lbl.textContent = labelText;
      wrap.appendChild(cb);
      wrap.appendChild(lbl);
      return { wrap: wrap, cb: cb };
    }

    var c1 = makeCheckbox('ch-close-cb1', 'Zeiteinträge sind vollständig erfasst');
    var c2 = makeCheckbox('ch-close-cb2', 'Kunde wurde benachrichtigt');
    var c3 = makeCheckbox('ch-close-cb3', 'Fahrten abgerechnet');
    dialog.appendChild(c1.wrap);
    dialog.appendChild(c2.wrap);
    dialog.appendChild(c3.wrap);

    // ── Klassifizierung ──
    dialog.appendChild(sep('Klassifizierung'));

    var klassiLbl = el('label', 'display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:4px;');
    klassiLbl.textContent = 'Klassifizierung *';
    var klassiSel = el('select',
      'width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px 10px;font-size:14px;' +
      'background:#fff;cursor:pointer;margin-bottom:4px;'
    );
    var defOpt = el('option', ''); defOpt.value = ''; defOpt.textContent = '-- Bitte wählen --';
    klassiSel.appendChild(defOpt);
    _klassifizierungOptions.forEach(function (name) {
      var opt = el('option', ''); opt.value = name; opt.textContent = name;
      klassiSel.appendChild(opt);
    });
    dialog.appendChild(klassiLbl);
    dialog.appendChild(klassiSel);

    // ── Schließungsstatus ──
    dialog.appendChild(sep('Schließungsstatus'));

    var statusLbl = el('label', 'display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:4px;');
    statusLbl.textContent = 'Schließungsstatus *';
    var statusSel = el('select',
      'width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px 10px;font-size:14px;' +
      'background:#fff;cursor:pointer;margin-bottom:4px;'
    );
    ['', 'Erfolglos', 'Erfolgreich', 'Keine Aktion erforderlich', 'Zwischenlösung'].forEach(function (val) {
      var o = el('option', ''); o.value = val; o.textContent = val || '-- Bitte wählen --';
      statusSel.appendChild(o);
    });
    dialog.appendChild(statusLbl);
    dialog.appendChild(statusSel);

    // ── Kommentare ──
    dialog.appendChild(sep('Kommentar'));

    var komLbl = el('label', 'display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:4px;');
    komLbl.textContent = 'Kommentar (öffentlich)';
    var komTA = el('textarea',
      'width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px 10px;font-size:14px;' +
      'font-family:inherit;resize:vertical;min-height:72px;box-sizing:border-box;margin-bottom:12px;'
    );
    komTA.placeholder = 'Abschlussnotiz für den Kunden …';
    dialog.appendChild(komLbl);
    dialog.appendChild(komTA);

    var komIntLbl = el('label', 'display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:4px;');
    komIntLbl.textContent = 'Kommentar (intern)';
    var komIntTA = el('textarea',
      'width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px 10px;font-size:14px;' +
      'font-family:inherit;resize:vertical;min-height:72px;box-sizing:border-box;'
    );
    komIntTA.placeholder = 'Interne Notiz (nur für Agenten) …';
    dialog.appendChild(komIntLbl);
    dialog.appendChild(komIntTA);

    // ── Buttons ──
    var buttonRow = el('div',
      'display:flex;gap:10px;justify-content:flex-end;margin-top:20px;' +
      'padding-top:16px;border-top:1px solid #f3f4f6;'
    );

    var cancelBtn = btn('Abbrechen',
      'border:1px solid #d1d5db;background:#fff;color:#374151;',
      function () { overlay.remove(); }
    );

    var confirmBtn = el('button',
      'padding:6px 16px;border-radius:4px;cursor:not-allowed;font-size:13px;' +
      'border:1px solid #6366f1;background:#6366f1;color:#fff;opacity:0.4;'
    );
    confirmBtn.textContent = 'Ticket schließen';
    confirmBtn.disabled = true;

    function updateConfirm() {
      var ok = c1.cb.checked && c2.cb.checked && c3.cb.checked && klassiSel.value !== '' && statusSel.value !== '';
      confirmBtn.disabled = !ok;
      confirmBtn.style.opacity = ok ? '1' : '0.4';
      confirmBtn.style.cursor = ok ? 'pointer' : 'not-allowed';
    }

    c1.cb.addEventListener('change', updateConfirm);
    c2.cb.addEventListener('change', updateConfirm);
    c3.cb.addEventListener('change', updateConfirm);
    klassiSel.addEventListener('change', updateConfirm);
    statusSel.addEventListener('change', updateConfirm);

    confirmBtn.addEventListener('click', function () {
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Speichern …';
      confirmBtn.style.opacity = '0.6';
      confirmBtn.style.cursor = 'not-allowed';

      var formData = {
        zeiteintraege_vollstaendig: c1.cb.checked ? 1 : 0,
        kunde_benachrichtigt: c2.cb.checked ? 1 : 0,
        fahrten_abgerechnet: c3.cb.checked ? 1 : 0,
        klassifizierung: klassiSel.value,
        schliessungsstatus: statusSel.value,
        schliessungs_kommentar: komTA.value,
        schliessungs_kommentar_intern: komIntTA.value,
      };

      apiMethod('frappe.client.set_value', {
        doctype: 'HD Ticket',
        name: ticketId,
        fieldname: 'status',
        value: targetStatus,
      }).then(function () {
        return apiMethod(
          'custom_helpdesk.python_scripts.billing.portal_api.save_closing_details',
          { ticket_name: ticketId, data: JSON.stringify(formData) }
        );
      }).then(function () {
        overlay.remove();
        // Vue SPA reloads automatically via helpdesk:ticket-update realtime event
        // triggered by HD Ticket's on_update hook
      }).catch(function (err) {
        console.error('[custom_helpdesk] Closing save error:', err);
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Ticket schließen';
        confirmBtn.style.opacity = '1';
        confirmBtn.style.cursor = 'pointer';
      });
    });

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(confirmBtn);
    dialog.appendChild(buttonRow);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  // ── Kalender sidebar link ───────────────────────────────────────────────────

  function injectKalenderSidebarLink() {
    if (document.getElementById('ch-kalender-link')) return;
    // The Helpdesk SPA sidebar contains <a> tags for navigation items.
    // Find the nav wrapper by looking for a known helpdesk path link.
    var sidebarAnchors = document.querySelectorAll('aside a, nav a, [class*="sidebar"] a');
    if (!sidebarAnchors.length) return;
    var lastAnchor = sidebarAnchors[sidebarAnchors.length - 1];
    var parent = lastAnchor && lastAnchor.parentElement;
    if (!parent) return;

    var link = document.createElement('a');
    link.id = 'ch-kalender-link';
    link.href = '/helpdesk-kalender';
    link.target = '_blank';
    link.style.cssText = lastAnchor.style.cssText || '';
    link.className = lastAnchor.className || '';
    link.textContent = '📅 Kalender';
    parent.appendChild(link);
  }

  // ── Route watcher ───────────────────────────────────────────────────────────

  var _lastPath = null;
  var _routeTimer = null;

  function handleRouteChange() {
    var path = location.pathname;
    if (path === _lastPath) return;
    _lastPath = path;

    // Clean up previous panel and banner
    removePanel();
    var banner = document.getElementById('ch-closed-banner');
    if (banner) banner.remove();

    clearTimeout(_routeTimer);

    var agentId = agentTicketId();
    var custId = customerTicketId();

    if (agentId) {
      // Delay to let Vue render the ticket page first
      _routeTimer = setTimeout(function () {
        renderTicketInfoPanel(agentId);
        renderPanel(agentId).then(function () {
          renderItemsPanel(agentId);
          renderTerminePanel(agentId);
        });
        injectKalenderSidebarLink();
      }, 1200);
    } else if (custId) {
      _routeTimer = setTimeout(function () { handleCustomerPortal(custId); }, 1000);
    }
  }

  // Intercept Vue Router's history navigation
  function _patchHistory(method) {
    var original = history[method];
    history[method] = function () {
      original.apply(this, arguments);
      setTimeout(handleRouteChange, 0);
    };
  }
  _patchHistory('pushState');
  _patchHistory('replaceState');
  window.addEventListener('popstate', handleRouteChange);

  // Pre-load closed status names + Klassifizierung options, install interceptor
  loadClosingData();
  installClosingInterceptor();

  // Initial check (covers hard-load directly onto a ticket URL)
  setTimeout(handleRouteChange, 600);

})();
