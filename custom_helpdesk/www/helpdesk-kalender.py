import frappe


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.throw("Nicht autorisiert", frappe.PermissionError)
    context.no_cache = 1
    context.csrf_token = (frappe.session.data.get("csrf_token") or "") if frappe.session.data else ""
    context.current_user = frappe.session.user
