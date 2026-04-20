app_name = "custom_helpdesk"
app_title = "Custom Helpdesk"
app_publisher = "ahmad900mohammad@gmail.com"
app_description = "Reusable Helpdesk extension connecting Frappe Helpdesk to ERPNext (timesheets, billing, invoicing)"
app_email = "ahmad900mohammad@gmail.com"
app_license = "mit"

# Apps
# ------------------

required_apps = ["frappe/helpdesk"]

# Each item in the list will be shown as an app in the apps page
# add_to_apps_screen = [
# 	{
# 		"name": "custom_helpdesk",
# 		"logo": "/assets/custom_helpdesk/logo.png",
# 		"title": "Custom Helpdesk",
# 		"route": "/custom_helpdesk",
# 		"has_permission": "custom_helpdesk.api.permission.has_app_permission"
# 	}
# ]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
# app_include_css = "/assets/custom_helpdesk/css/custom_helpdesk.css"
# app_include_js = "/assets/custom_helpdesk/js/custom_helpdesk.js"

# include js, css files in header of web template
# web_include_css = "/assets/custom_helpdesk/css/custom_helpdesk.css"
# web_include_js = "/assets/custom_helpdesk/js/custom_helpdesk.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "custom_helpdesk/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
doctype_js = {
    "Customer": "js_scripts/customer.js",
}
doctype_list_js = {
    "Contact": "js_scripts/contact_list.js",
}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
# app_include_icons = "custom_helpdesk/public/icons.svg"

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# Jinja
# ----------

# add methods and filters to jinja environment
# jinja = {
# 	"methods": "custom_helpdesk.utils.jinja_methods",
# 	"filters": "custom_helpdesk.utils.jinja_filters"
# }

# Installation
# ------------

# before_install = "custom_helpdesk.install.before_install"
# after_install = "custom_helpdesk.install.after_install"

# Uninstallation
# ------------

# before_uninstall = "custom_helpdesk.uninstall.before_uninstall"
# after_uninstall = "custom_helpdesk.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "custom_helpdesk.utils.before_app_install"
# after_app_install = "custom_helpdesk.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "custom_helpdesk.utils.before_app_uninstall"
# after_app_uninstall = "custom_helpdesk.utils.after_app_uninstall"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "custom_helpdesk.notifications.get_notification_config"

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# DocType Class
# ---------------
# Override standard doctype classes

# override_doctype_class = {
# 	"ToDo": "custom_app.overrides.CustomToDo"
# }

# Document Events
# ---------------
doc_events = {
    # Sync ERPNext Customer → HD Customer
    "Customer": {
        "after_insert": "custom_helpdesk.python_scripts.sync.customer_sync.sync_to_hd_customer",
        "after_save": "custom_helpdesk.python_scripts.sync.customer_sync.sync_to_hd_customer",
    },
    # Mark contacts created from Helpdesk portal with Supportkontakt + aus_supportvorgang
    "Contact": {
        "after_insert": "custom_helpdesk.python_scripts.sync.contact_sync.after_contact_insert",
    },
    # Mark addresses created from Helpdesk context with aus_supportvorgang
    "Address": {
        "after_insert": "custom_helpdesk.python_scripts.sync.address_sync.after_address_insert",
    },
}

# Fixtures — custom fields applied on migrate
fixtures = [
    {
        "doctype": "Custom Field",
        "filters": [
            ["name", "in", [
                "Contact-aus_supportvorgang",
                "Contact-supportkontakt",
                "Address-aus_supportvorgang",
                "Customer-helpdesk_domain",
                "Customer-dienstleistungskontingent",
            ]],
        ],
    },
]

# Scheduled Tasks
# ---------------

# scheduler_events = {
# 	"all": [
# 		"custom_helpdesk.tasks.all"
# 	],
# 	"daily": [
# 		"custom_helpdesk.tasks.daily"
# 	],
# 	"hourly": [
# 		"custom_helpdesk.tasks.hourly"
# 	],
# 	"weekly": [
# 		"custom_helpdesk.tasks.weekly"
# 	],
# 	"monthly": [
# 		"custom_helpdesk.tasks.monthly"
# 	],
# }

# Testing
# -------

# before_tests = "custom_helpdesk.install.before_tests"

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "custom_helpdesk.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "custom_helpdesk.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["custom_helpdesk.utils.before_request"]
# after_request = ["custom_helpdesk.utils.after_request"]

# Job Events
# ----------
# before_job = ["custom_helpdesk.utils.before_job"]
# after_job = ["custom_helpdesk.utils.after_job"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"custom_helpdesk.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
# export_python_type_annotations = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }

# Translation
# ------------
# List of apps whose translatable strings should be excluded from this app's translations.
# ignore_translatable_strings_from = []

