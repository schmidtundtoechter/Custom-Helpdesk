import frappe


def before_customer_save(doc, method=None):
    if doc.is_new():
        doc._old_customer_name = None
        doc._old_helpdesk_domain = None
        return

    old = frappe.db.get_value(
        "Customer",
        doc.name,
        ["customer_name", "helpdesk_domain"],
        as_dict=True,
    )
    doc._old_customer_name = old.customer_name if old else None
    doc._old_helpdesk_domain = old.helpdesk_domain if old else None


def sync_to_hd_customer(doc, method=None):
    if frappe.flags.in_patch or frappe.flags.in_install or frappe.flags.in_migrate:
        return
    if getattr(frappe.flags, "custom_helpdesk_syncing", False):
        return

    try:
        frappe.flags.custom_helpdesk_syncing = True
        _sync(doc)
    finally:
        frappe.flags.custom_helpdesk_syncing = False


def after_customer_rename(doc, method=None, old=None, new=None, merge=None):
    if frappe.flags.in_patch or frappe.flags.in_install or frappe.flags.in_migrate:
        return

    hd_name = frappe.db.get_value("HD Customer", {"custom_erp_customer": old}, "name")
    if hd_name:
        hd = frappe.get_doc("HD Customer", hd_name)
        hd.custom_erp_customer = new
        hd.save(ignore_permissions=True)


def _sync(customer_doc):
    customer_docname = customer_doc.name
    new_customer_name = customer_doc.customer_name
    old_customer_name = getattr(customer_doc, "_old_customer_name", None)
    domain = customer_doc.get("helpdesk_domain") or ""

    # 1) find existing HD Customer
    hd_name = frappe.db.get_value("HD Customer", {"custom_erp_customer": customer_docname}, "name")

    if not hd_name and old_customer_name:
        hd_name = frappe.db.get_value("HD Customer", {"customer_name": old_customer_name}, "name")

    if not hd_name:
        hd_name = frappe.db.get_value("HD Customer", {"customer_name": new_customer_name}, "name")

    # 2) create if missing
    if not hd_name:
        hd = frappe.new_doc("HD Customer")
        hd.customer_name = new_customer_name
        hd.domain = domain
        hd.custom_erp_customer = customer_docname
        hd.insert(ignore_permissions=True)
        return

    # 3) rename doc if needed
    if (
        old_customer_name
        and hd_name == old_customer_name
        and new_customer_name
        and hd_name != new_customer_name
    ):
        frappe.rename_doc("HD Customer", hd_name, new_customer_name, force=True)
        hd_name = new_customer_name

    # 4) update fields after rename
    hd = frappe.get_doc("HD Customer", hd_name)
    changed = False

    if hd.customer_name != new_customer_name:
        hd.customer_name = new_customer_name
        changed = True

    if hd.domain != domain:
        hd.domain = domain
        changed = True

    if hd.custom_erp_customer != customer_docname:
        hd.custom_erp_customer = customer_docname
        changed = True

    if changed:
        hd.save(ignore_permissions=True)