frappe.listview_settings["Contact"] = frappe.listview_settings["Contact"] || {};

frappe.listview_settings["Contact"].onload = function (listview) {
    // Guard: only add filter if the custom field exists on this site (requires bench migrate).
    // Without this check, Frappe rejects the filter server-side with "Invalid filter: supportkontakt".
    const meta = frappe.get_meta("Contact");
    if (!meta || !meta.fields.some(f => f.fieldname === "supportkontakt")) return;

    // Hide Helpdesk-created support contacts by default.
    // Staff can remove this filter manually to see all contacts.
    const has_filter = (listview.filter_area.filter_list.filters || []).some(
        f => f.fieldname === "supportkontakt"
    );
    if (!has_filter) {
        listview.filter_area.add([["Contact", "supportkontakt", "=", 0]]);
    }
};
