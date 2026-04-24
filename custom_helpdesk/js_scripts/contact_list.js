frappe.listview_settings["Contact"] = frappe.listview_settings["Contact"] || {};

frappe.listview_settings["Contact"].onload = function (listview) {
    const meta = frappe.get_meta("Contact");
    if (!meta || !meta.fields.some(f => f.fieldname === "aus_supportvorgang")) return;

    if (listview._sv_patched) return;
    listview._sv_patched = true;

    function silent_remove(f) {
        try { f.$filter_edit_area && f.$filter_edit_area.remove(); } catch (_) {}
        listview.filter_area.filter_list.filters =
            (listview.filter_area.filter_list.filters || []).filter(x => x !== f);
    }

    // SERVER-SIDE: intercept every DB query so exactly one correct filter is sent.
    // - no filter in bar   → add != 1  (hide support contacts by default)
    // - both = 1 and != 1  → drop != 1 (user checked the checkbox, show support contacts)
    const orig_get_args = listview.get_args.bind(listview);
    listview.get_args = function () {
        const args = orig_get_args();
        const sv = (args.filters || []).filter(f => f[1] === "aus_supportvorgang");
        if (sv.length === 0) {
            args.filters.push(["Contact", "aus_supportvorgang", "!=", 1]);
        } else if (sv.length > 1 && sv.some(f => f[2] === "=")) {
            args.filters = args.filters.filter(
                f => !(f[1] === "aus_supportvorgang" && f[2] === "!=")
            );
        }
        return args;
    };

    // VISUAL (initial): after Frappe restores URL state, clean up any conflict in the filter bar.
    setTimeout(function () {
        const filters = listview.filter_area.filter_list.filters || [];
        const not_eq = filters.find(f => f.fieldname === "aus_supportvorgang" && f.condition === "!=");
        const eq     = filters.find(f => f.fieldname === "aus_supportvorgang" && f.condition === "=");
        if (not_eq && eq) {
            silent_remove(not_eq); // drop the != 1 chip so only = 1 shows
        }
        // No filter at all: get_args adds != 1 server-side invisibly; that's fine.
    }, 300);
};

// VISUAL (ongoing): after every refresh, silently drop != 1 when = 1 is also present.
frappe.listview_settings["Contact"].refresh = function () {
    const meta = frappe.get_meta("Contact");
    if (!meta || !meta.fields.some(f => f.fieldname === "aus_supportvorgang")) return;

    const filters = this.filter_area.filter_list.filters || [];
    const not_eq  = filters.find(f => f.fieldname === "aus_supportvorgang" && f.condition === "!=");
    const eq      = filters.find(f => f.fieldname === "aus_supportvorgang" && f.condition === "=");

    if (not_eq && eq) {
        try { not_eq.$filter_edit_area && not_eq.$filter_edit_area.remove(); } catch (_) {}
        this.filter_area.filter_list.filters = filters.filter(f => f !== not_eq);
    }
};
