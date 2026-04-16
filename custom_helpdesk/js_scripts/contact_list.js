frappe.listview_settings["Contact"] = frappe.listview_settings["Contact"] || {};

frappe.listview_settings["Contact"].onload = function (listview) {
    // Hide Helpdesk-created support contacts by default.
    // Staff can remove this filter manually to see all contacts.
    const has_filter = listview.filter_area.filter_list.filters.some(
        (f) => f.fieldname === "supportkontakt"
    );
    if (!has_filter) {
        listview.filter_area.add([["Contact", "supportkontakt", "=", 0]]);
    }
};
