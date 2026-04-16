frappe.ui.form.on("Customer", {
    refresh(frm) {
        frm.add_custom_button(__("Support Overview"), function () {
            frappe.set_route("query-report", "Customer Support Overview", {
                customer: frm.doc.name,
            });
        }, __("Helpdesk"));
    },
});
