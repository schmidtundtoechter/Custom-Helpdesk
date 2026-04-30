/**
 * helpdesk_portal.js — Custom Helpdesk extension for the Frappe Helpdesk Vue SPA.
 *
 * Injected via the www/helpdesk/index.html template override. This file runs
 * in the Helpdesk portal context (/helpdesk/*), not the ERPNext Desk.
 *
 * Features:
 *  - Agent ticket view (/helpdesk/tickets/:id):
 *      Zeiterfassung panel: timer start/stop, multiplier, price category, Buchen, history
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

  // ── Time log data ───────────────────────────────────────────────────────────

  function getTimeLogs(ticketName) {
    // Direct REST access to child tables (istable=1) is blocked by Frappe with 403.
    // Use a whitelisted method on the parent ticket instead.
    return apiMethod(
      'custom_helpdesk.python_scripts.billing.portal_api.get_time_logs',
      { ticket_name: ticketName }
    ).then(function (res) { return res.message || []; });
  }

  // ── Panel DOM helpers ───────────────────────────────────────────────────────

  var PANEL_ID = 'ch-zeiterfassung-panel';

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

  // ── Agent Zeiterfassung panel ───────────────────────────────────────────────

  function removePanel() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
  }

  function renderPanel(ticketId) {
    return Promise.all([getTimeLogs(ticketId), getPriceCategories()]).then(function (results) {
      var logs = results[0];
      var priceCats = results[1];
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

      var activeRow = null;
      for (var i = logs.length - 1; i >= 0; i--) {
        if (logs[i].start_time && !logs[i].end_time) { activeRow = logs[i]; break; }
      }
      var hasBookable = logs.some(function (r) { return !r.gesperrt && !r.is_invoiced; });

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

      // Timer buttons
      var btnRow = el('div', 'display:flex;gap:8px;margin-bottom:12px;');

      var startBg = activeRow ? '#d1fae5' : '#10b981';
      var startFg = activeRow ? '#065f46' : '#fff';
      var startBtn = btn(
        activeRow ? '⏱ Timer läuft...' : '▶ Start Timer',
        'border:1px solid #10b981;background:' + startBg + ';color:' + startFg + ';',
        function () {
          startBtn.disabled = true;
          startBtn.textContent = 'Starte...';
          apiMethod('custom_helpdesk.python_scripts.billing.portal_api.start_timer', {
            ticket_name: ticketId,
          }).then(function () { renderPanel(ticketId); });
        }
      );
      startBtn.disabled = !!activeRow;

      var stopBg = activeRow ? '#ef4444' : '#f3f4f6';
      var stopFg = activeRow ? '#fff' : '#9ca3af';
      var stopBtn = btn(
        '⏹ Stop Timer',
        'border:1px solid #ef4444;background:' + stopBg + ';color:' + stopFg + ';',
        function () {
          if (!activeRow) return;
          stopBtn.disabled = true;
          stopBtn.textContent = 'Stoppe...';
          apiMethod('custom_helpdesk.python_scripts.billing.portal_api.stop_timer', {
            ticket_name: ticketId,
            row_name: activeRow.name,
          }).then(function () { renderPanel(ticketId); });
        }
      );
      stopBtn.disabled = !activeRow;

      btnRow.appendChild(startBtn);
      btnRow.appendChild(stopBtn);
      body.appendChild(btnRow);

      // Time logs table
      if (logs.length) {
        var table = el('table', 'width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px;');
        table.innerHTML =
          '<thead><tr style="border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;">' +
            '<th style="text-align:left;padding:4px 8px;">Start</th>' +
            '<th style="text-align:left;padding:4px 8px;">Ende</th>' +
            '<th style="text-align:right;padding:4px 8px;">Eff. (h)</th>' +
            '<th style="text-align:center;padding:4px 8px;">× Mult.</th>' +
            '<th style="text-align:left;padding:4px 8px;">Preiskategorie</th>' +
            '<th style="text-align:right;padding:4px 8px;">Gesamt (h)</th>' +
            '<th style="text-align:left;padding:4px 8px;">Mitarbeiter</th>' +
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
            tr.innerHTML =
              '<td style="padding:4px 8px;">' + fmtDT(row.start_time) + '</td>' +
              '<td style="padding:4px 8px;">' + (row.end_time ? fmtDT(row.end_time) : '...') + '</td>' +
              '<td style="text-align:right;padding:4px 8px;">' + eff.toFixed(2) + '</td>' +
              '<td style="text-align:center;padding:4px 8px;">' + mult + '</td>' +
              '<td style="padding:4px 8px;">' + pcLabel + '</td>' +
              '<td style="text-align:right;padding:4px 8px;">' + total.toFixed(2) + '</td>' +
              '<td style="padding:4px 8px;">' + (row.staff_member || '–') + '</td>' +
              '<td style="text-align:center;padding:4px 8px;color:' + (row.ruecksprache_erforderlich ? '#d97706' : 'inherit') + ';">' + (row.ruecksprache_erforderlich ? '✓' : '') + '</td>';
            tr.appendChild(statusCell);
          } else {
            var pcOptions = priceCats.map(function (p) {
              return '<option value="' + p.name + '"' + (p.name === row.price_category ? ' selected' : '') + '>' +
                p.time_code + ' – ' + p.category_name + '</option>';
            }).join('');

            var multOptions = [1, 2, 3, 4, 5].map(function (v) {
              return '<option value="' + v + '"' + (v === mult ? ' selected' : '') + '>' + v + '</option>';
            }).join('');

            tr.innerHTML =
              '<td style="padding:4px 8px;">' + fmtDT(row.start_time) + '</td>' +
              '<td style="padding:4px 8px;">' + (row.end_time ? fmtDT(row.end_time) : '...') + '</td>' +
              '<td style="text-align:right;padding:4px 8px;" class="ch-eff-' + row.name + '">' + eff.toFixed(2) + '</td>' +
              '<td style="text-align:center;padding:4px 8px;">' +
                '<select class="ch-mult" data-row="' + row.name + '" style="width:50px;border:1px solid #d1d5db;border-radius:3px;padding:2px;">' + multOptions + '</select>' +
              '</td>' +
              '<td style="padding:4px 8px;">' +
                '<select class="ch-pc" data-row="' + row.name + '" style="border:1px solid #d1d5db;border-radius:3px;padding:2px;max-width:200px;">' +
                  '<option value="">– wählen –</option>' + pcOptions +
                '</select>' +
              '</td>' +
              '<td style="text-align:right;padding:4px 8px;" class="ch-tot-' + row.name + '">' + total.toFixed(2) + '</td>' +
              '<td style="padding:4px 8px;">' + (row.staff_member || '–') + '</td>' +
              '<td style="text-align:center;padding:4px 8px;">' +
                '<input type="checkbox" class="ch-rueck" data-row="' + row.name + '"' + (row.ruecksprache_erforderlich ? ' checked' : '') + ' style="cursor:pointer;width:16px;height:16px;">' +
              '</td>';
            tr.appendChild(statusCell);

            // Save on change
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
                    // Refresh header stats
                    renderPanel(ticketId);
                  }
                });
              });
            });

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
          }

          tbody.appendChild(tr);
        });

        body.appendChild(table);
      } else {
        var empty = el('p', 'color:#9ca3af;font-size:13px;margin-bottom:12px;');
        empty.textContent = 'Noch keine Zeiteinträge.';
        body.appendChild(empty);
      }

      // Buchen button
      if (hasBookable) {
        var buchenBtn = btn(
          'Buchen → ERPNext Timesheet',
          'border:1px solid #3b82f6;background:#3b82f6;color:#fff;margin-top:4px;',
          function () {
            if (!confirm('Alle offenen Zeiteinträge als ERPNext Timesheet buchen?')) return;
            buchenBtn.disabled = true;
            buchenBtn.textContent = 'Buche...';
            apiMethod('custom_helpdesk.python_scripts.billing.buchen.buchen', {
              ticket_name: ticketId,
            }).then(function (res) {
              if (res.message) {
                alert('Timesheet ' + res.message + ' wurde erstellt.');
                renderPanel(ticketId);
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

        // Insert after Vue content — wait for Vue's ticket view to render
        _insertPanel(panel);
      });
    }).catch(function (err) {
      console.error('[custom_helpdesk] Zeiterfassung panel error:', err);
    });
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
      _routeTimer = setTimeout(function () { renderPanel(agentId); }, 1200);
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

  // Initial check (covers hard-load directly onto a ticket URL)
  setTimeout(handleRouteChange, 600);

})();
