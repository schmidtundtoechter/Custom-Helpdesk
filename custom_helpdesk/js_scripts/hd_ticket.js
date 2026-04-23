frappe.ui.form.on("HD Ticket", {
    refresh(frm) {
        _add_buchen_button(frm);
        _add_timer_buttons(frm);
        _render_buchen_history(frm);
        _show_unbezahlte_supportzeit(frm);
    },

    before_save(frm) {
        _recalculate_totals(frm);
    },
});

// ── Timer ──────────────────────────────────────────────────────────────────

frappe.ui.form.on("Support Time Log", {
    start_time(frm, cdt, cdn) {
        _recalculate_row(frm, cdt, cdn);
    },
    end_time(frm, cdt, cdn) {
        _recalculate_row(frm, cdt, cdn);
    },
    manual_override(frm, cdt, cdn) {
        _recalculate_row(frm, cdt, cdn);
    },
    multiplier(frm, cdt, cdn) {
        _recalculate_row(frm, cdt, cdn);
    },
    price_category(frm, cdt, cdn) {
        _recalculate_row(frm, cdt, cdn);
    },
});

function _add_timer_buttons(frm) {
    if (frm.doc.docstatus !== 0) return;

    frm.add_custom_button(__("Start Timer"), function () {
        const row = frm.add_child("support_time_logs");
        row.start_time = frappe.datetime.now_datetime();
        row.entered_by = frappe.session.user;
        row.multiplier = "1";
        frm.refresh_field("support_time_logs");
        frm.save();
        frappe.show_alert({ message: __("Timer gestartet"), indicator: "green" });
    }, __("Timer"));

    frm.add_custom_button(__("Pause / Stop Timer"), function () {
        const logs = frm.doc.support_time_logs || [];
        // Find the last row without an end_time
        const active = logs.slice().reverse().find(r => r.start_time && !r.end_time);
        if (!active) {
            frappe.msgprint(__("Kein aktiver Timer gefunden."));
            return;
        }
        frappe.model.set_value(active.doctype, active.name, "end_time", frappe.datetime.now_datetime());
        frm.refresh_field("support_time_logs");
        frm.save();
        frappe.show_alert({ message: __("Timer gestoppt"), indicator: "blue" });
    }, __("Timer"));
}

function _recalculate_row(frm, cdt, cdn) {
    const row = frappe.get_doc(cdt, cdn);
    if (row.start_time && row.end_time) {
        const start = moment(row.start_time);
        const end = moment(row.end_time);
        const duration = Math.max(end.diff(start, "hours", true), 0);
        frappe.model.set_value(cdt, cdn, "duration", Math.round(duration * 100) / 100);
    }

    const effective = row.manual_override || row.duration || 0;
    frappe.model.set_value(cdt, cdn, "effective_duration", effective);

    // Fetch price_per_hour and recalculate total_cost
    if (row.price_category && effective) {
        frappe.db.get_value("Support Price Category", row.price_category, "price_per_hour", (r) => {
            const price = r.price_per_hour || 0;
            const mult = parseInt(row.multiplier || 1);
            frappe.model.set_value(cdt, cdn, "total_cost", effective * mult * price);
            _recalculate_totals(frm);
        });
    } else {
        _recalculate_totals(frm);
    }
}

function _recalculate_totals(frm) {
    let total = 0, unbilled = 0;
    for (const row of frm.doc.support_time_logs || []) {
        const eff = parseFloat(row.effective_duration || 0);
        const mult = parseInt(row.multiplier || 1);
        const hours = eff * mult;
        if (!row.is_locked) total += hours;
        if (!row.is_invoiced) unbilled += hours;
    }
    frm.set_value("total_support_time", Math.round(total * 100) / 100);
    frm.set_value("unbezahlte_supportzeit", Math.round(unbilled * 100) / 100);
}

// ── Buchen ─────────────────────────────────────────────────────────────────

function _add_buchen_button(frm) {
    if (frm.doc.docstatus !== 0 || frm.is_new()) return;

    const unbookable = (frm.doc.support_time_logs || []).filter(
        r => !r.is_locked && !r.is_invoiced
    );
    if (!unbookable.length) return;

    frm.add_custom_button(__("Buchen"), function () {
        frappe.confirm(
            __("Alle {0} nicht gesperrten Zeiteinträge als ERPNext Timesheet buchen?", [unbookable.length]),
            function () {
                frappe.call({
                    method: "custom_helpdesk.python_scripts.billing.buchen.buchen",
                    args: { ticket_name: frm.doc.name },
                    freeze: true,
                    freeze_message: __("Erstelle Timesheet..."),
                    callback(r) {
                        if (r.message) {
                            frappe.show_alert({
                                message: __("Timesheet {0} erstellt", [
                                    `<a href="/app/timesheet/${r.message}">${r.message}</a>`
                                ]),
                                indicator: "green",
                            });
                            frm.reload_doc();
                        }
                    },
                });
            }
        );
    }, __("Abrechnung"));
}

function _render_buchen_history(frm) {
    if (frm.is_new()) return;

    frappe.call({
        method: "custom_helpdesk.python_scripts.billing.buchen.get_buchen_history",
        args: { ticket_name: frm.doc.name },
        callback(r) {
            if (!r.message || !r.message.length) return;

            const rows = r.message.map(item =>
                `<tr>
                    <td>${frappe.datetime.str_to_user(item.buchen_timestamp)}</td>
                    <td><a href="/app/timesheet/${item.timesheet}">${item.timesheet}</a></td>
                    <td>${(item.total_hours || 0).toFixed(2)} h</td>
                </tr>`
            ).join("");

            const html = `
                <div class="mt-3">
                    <strong>${__("Buchungshistorie")}</strong>
                    <table class="table table-bordered table-sm mt-2">
                        <thead><tr>
                            <th>${__("Datum")}</th>
                            <th>${__("Timesheet")}</th>
                            <th>${__("Stunden")}</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>`;

            // Render below the child table
            const $wrapper = frm.get_field("support_time_logs").$wrapper;
            $wrapper.find(".buchen-history").remove();
            $wrapper.append(`<div class="buchen-history">${html}</div>`);
        },
    });
}

function _show_unbezahlte_supportzeit(frm) {
    if (frm.is_new()) return;
    const val = frm.doc.unbezahlte_supportzeit || 0;
    if (val > 0) {
        frm.dashboard.add_comment(
            __("Unbezahlte Supportzeit: {0} h", [val.toFixed(2)]),
            "yellow",
            true
        );
    }
}
