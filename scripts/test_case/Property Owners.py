from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule
from pathlib import Path

path = Path("/mnt/data/HOA_Dashboard_QA_Tracker.xlsx")
wb = load_workbook(path)

# Create a dedicated Property Owners QA sheet
if "Property Owners QA" in wb.sheetnames:
    del wb["Property Owners QA"]

ws = wb.create_sheet("Property Owners QA")

headers = [
    "TC ID","Module","Scenario","Preconditions","Test Data","Steps",
    "Expected Result","Actual Result","Status","Priority","Bug ID",
    "Tester","Evidence","Remarks"
]

cases = []

def add(tc, scenario, pre, data, steps, expected, priority="High"):
    cases.append([
        tc, "Property Owners", scenario, pre, data, steps, expected,
        "", "Not Started", priority, "", "", "", ""
    ])

# Search
add("OWN-001","Search owner by full owner name",
    "Property Owners page is open and owner exists",
    "Four Owner 4",
    "Enter exact owner name in Search owners → wait for results",
    "Only matching owner records are displayed and the owner name/details are correct.")
add("OWN-002","Search owner by partial owner name",
    "Property Owners page is open",
    "Owner name fragment",
    "Enter partial owner name",
    "Matching owners are returned; unrelated owners are not returned.")
add("OWN-003","Search owner with no matching result",
    "Property Owners page is open",
    "Random/non-existing owner name",
    "Enter non-existing owner name",
    "No matching result is displayed and the empty-state message is correct.")
add("OWN-004","Clear owner search",
    "Search has filtered the list",
    "Existing search text",
    "Remove search text / clear search field",
    "Full owner list is restored.")
add("OWN-005","Search is case-insensitive",
    "Owner exists",
    "Different letter casing",
    "Search the same owner using upper/lower/mixed case",
    "Matching owner is found regardless of letter casing if search is intended to be case-insensitive.")
add("OWN-006","Search with leading/trailing spaces",
    "Owner exists",
    "Owner name with spaces around it",
    "Enter search text with leading/trailing spaces",
    "Search handles spaces correctly and returns the expected owner.")

# Property / unit search
add("OWN-007","Search by property name",
    "Owner has a property assigned",
    "Five-Swpt-16",
    "Open Filters → Search property and unit → enter property name → Apply filters",
    "Owners associated with the matching property are displayed.")
add("OWN-008","Search by unit name",
    "Owner has a unit assigned",
    "Unit 89",
    "Open Filters → Search property and unit → enter unit name → Apply filters",
    "Owners associated with the matching unit are displayed.")
add("OWN-009","Search by property + unit",
    "Matching property/unit association exists",
    "Five-Swpt-16 - Unit 89",
    "Enter property and unit together → Apply filters",
    "Only owners associated with the specified property/unit combination are displayed.")
add("OWN-010","Search property/unit with partial text",
    "Property/unit exists",
    "Partial property or unit text",
    "Enter partial property/unit text",
    "Relevant matching owners are returned.")
add("OWN-011","Search property/unit with no result",
    "Filters are available",
    "Non-existing property/unit",
    "Enter non-existing property/unit → Apply filters",
    "No matching owners are returned.")
add("OWN-012","Clear property/unit search",
    "Property/unit filter is applied",
    "Existing filter",
    "Open Filters → Clear filters",
    "Property/unit filter is removed and owner list returns to the unfiltered state.")

# Owner details/list
add("OWN-013","Verify owner list details",
    "Owner records exist",
    "Owner name, property/unit, effective date, contact, status",
    "Review each visible owner row",
    "Owner name, property/unit, ownership effective date, contact information and account status are displayed correctly.")
add("OWN-014","Verify owner numbering",
    "Multiple owner records exist",
    "1, 2, 3, ...",
    "Review list row numbers",
    "Row numbering is sequential and updates correctly with filtering/pagination.")
add("OWN-015","Verify property/unit chips",
    "Owner has one or multiple property/unit associations",
    "Multiple units",
    "Review Property / Unit column",
    "Associated property/unit information is displayed correctly; additional associations are represented consistently.")
add("OWN-016","Verify ownership effective date",
    "Owner has an effective ownership date",
    "September 18, 2026",
    "Review owner row",
    "Effective date matches the source record and uses the expected date format.")
add("OWN-017","Verify contact information",
    "Owner has email and/or phone",
    "Email + phone",
    "Review Contact column",
    "Email and phone are displayed accurately; missing phone is handled as designed.")
add("OWN-018","Open owner details from list",
    "Owner row is available and row action supports details",
    "Existing owner",
    "Click owner row/name or supported details action",
    "Correct owner details page/modal opens for the selected owner.")

# Filters
add("OWN-019","Open Filters modal",
    "Property Owners page is open",
    "Filters button",
    "Click Filters",
    "Filter owners modal opens with Property/Unit, Owner and Account Status controls.")
add("OWN-020","Owner dropdown shows all owners",
    "Filter modal is open and owners exist",
    "All owners",
    "Open Select owner dropdown",
    "Owner options are loaded correctly and All owners is available.")
add("OWN-021","Filter by specific owner",
    "Filter modal is open",
    "Specific owner",
    "Select an owner → Apply filters",
    "Only records for the selected owner are displayed.")
add("OWN-022","Filter by property/unit",
    "Filter modal is open",
    "Property/unit",
    "Enter property/unit → Apply filters",
    "Only matching owner associations are displayed.")
add("OWN-023","Combine owner + property/unit filters",
    "Matching combination exists",
    "Owner + property/unit",
    "Select owner and enter property/unit → Apply filters",
    "Results satisfy both selected criteria.")
add("OWN-024","Open account status filter",
    "Filter modal is open",
    "Verified / Pending Verification / Invitation Sent",
    "Review Account Status section",
    "All three statuses are available as selectable filter options.")
add("OWN-025","Filter by Verified",
    "Verified owner records exist",
    "Verified",
    "Select Verified → Apply filters",
    "Only Verified owner records are displayed.")
add("OWN-026","Filter by Pending Verification",
    "Pending Verification records exist",
    "Pending Verification",
    "Select Pending Verification → Apply filters",
    "Only Pending Verification owner records are displayed.")
add("OWN-027","Filter by Invitation Sent",
    "Invitation Sent records exist",
    "Invitation Sent",
    "Select Invitation Sent → Apply filters",
    "Only Invitation Sent owner records are displayed.")
add("OWN-028","Combine account status + property/unit",
    "Matching records exist",
    "Status + property/unit",
    "Select status → enter property/unit → Apply filters",
    "Results satisfy both filters.")
add("OWN-029","Clear filters",
    "At least one filter is applied",
    "Applied filters",
    "Open Filters → click Clear filters",
    "All filter selections are cleared.")
add("OWN-030","Clear filters restores complete list",
    "Filtered results are displayed",
    "Applied filter",
    "Click Clear filters → Apply if required by UI",
    "Complete applicable owner list is restored.")
add("OWN-031","Close filter modal without applying",
    "Filter modal is open and changes have been made",
    "Unsaved filter selection",
    "Make a filter selection → close modal without Apply",
    "Unapplied changes do not affect the owner list, according to the intended UI behavior.")

# Pagination
add("OWN-032","Verify pagination is displayed when required",
    "Owner count exceeds one page",
    "More records than page size",
    "Open Property Owners",
    "Pagination controls are displayed when records exceed the configured page size.")
add("OWN-033","Navigate to next page",
    "Multiple pages of owners exist",
    "Page 1 / Page 2",
    "Click Next",
    "Next page loads with the correct owner records and no duplicates/missing records.")
add("OWN-034","Navigate to previous page",
    "User is on page 2 or later",
    "Previous page",
    "Click Previous",
    "Previous page loads correctly.")
add("OWN-035","Verify page boundary",
    "Multiple pages exist",
    "First/last page",
    "Navigate to first and last page",
    "Previous/Next controls are enabled/disabled correctly at boundaries.")
add("OWN-036","Pagination with search",
    "Search returns multiple pages",
    "Search term",
    "Search owner → navigate pages",
    "Pagination applies to the filtered result set, not the full unfiltered list.")
add("OWN-037","Pagination with filters",
    "Filters return multiple pages",
    "Status/property filter",
    "Apply filter → navigate pages",
    "Pagination applies to the filtered result set and counts are correct.")

# Refresh
add("OWN-038","Refresh owner list",
    "Property Owners page is open",
    "Refresh button",
    "Click Refresh",
    "Latest owner data is retrieved and displayed without errors.")
add("OWN-039","Verify refresh after creating owner",
    "A new owner can be created",
    "New owner",
    "Create owner → return to list → click Refresh",
    "New owner appears with correct details/status.")
add("OWN-040","Verify refresh after updating owner",
    "Existing owner can be updated",
    "Updated owner details",
    "Update owner → click Refresh",
    "Updated details appear correctly.")
add("OWN-041","Verify refresh after deleting owner",
    "Owner can be deleted according to permissions",
    "Existing owner",
    "Delete owner → click Refresh",
    "Deleted owner is no longer displayed where applicable.")

# Export
add("OWN-042","Export owner list",
    "User has export permission and owner records exist",
    "Owner dataset",
    "Click Export",
    "Owner data export is generated/downloaded successfully.")
add("OWN-043","Verify exported owner fields",
    "Export is available",
    "Owner records",
    "Export → open generated file",
    "Export contains the expected owner/property/unit/date/contact/status fields.")
add("OWN-044","Export filtered owner list",
    "A filter is applied",
    "Verified or property filter",
    "Apply filter → Export",
    "Export contains the filtered dataset if export is designed to respect active filters.")
add("OWN-045","Export searched owner list",
    "Search is applied",
    "Owner search",
    "Search owner → Export",
    "Export contains the applicable search result set if export respects search.")
add("OWN-046","Export with no records",
    "Search/filter produces no results",
    "No matching records",
    "Apply no-result filter → Export",
    "System handles empty export gracefully according to product behavior.")

# List / cards / UI
add("OWN-047","Switch List view to Cards view",
    "Property Owners page is open",
    "List / Cards",
    "Click Cards",
    "Cards view opens and displays the same applicable owner dataset.")
add("OWN-048","Switch Cards view back to List",
    "Cards view is open",
    "List / Cards",
    "Click List",
    "List view opens with the applicable owner dataset.")
add("OWN-049","Verify sorting by Owner",
    "Multiple owners exist",
    "Owner names",
    "Click Owner sort control",
    "Owner list sorts in the selected direction correctly.")
add("OWN-050","Verify refresh timestamp",
    "Property Owners page is open",
    "Updated Just now / relative time",
    "Refresh or perform data change",
    "Updated timestamp reflects the latest successful data refresh according to the product's time display rules.")

# Security / isolation
add("OWN-051","Verify HOA data isolation",
    "Two HOAs have different owners",
    "Community 1 / another community",
    "Switch/login to Community 1 → review owner list",
    "Owners belonging to another HOA/community are not displayed.","Critical")
add("OWN-052","Verify owner search respects HOA isolation",
    "Same/similar owner names exist in different HOAs",
    "Owner name",
    "Search owner name in Community 1",
    "Only the current HOA's authorized owner records are returned.","Critical")
add("OWN-053","Verify export respects HOA isolation",
    "Multiple HOAs have owner records",
    "Export",
    "Export owners from current HOA",
    "Export contains only authorized/current HOA owner data.","Critical")

# Edge cases
add("OWN-054","Owner with multiple units",
    "Owner is associated with multiple units",
    "Unit 89, Unit 80, additional unit",
    "Review owner row/details",
    "All applicable associations are represented correctly without losing or duplicating ownership records.")
add("OWN-055","Owner with no phone number",
    "Owner email exists but phone is missing",
    "No phone provided",
    "Review owner list",
    "Email is displayed and missing phone is shown using the intended placeholder.")
add("OWN-056","Very long owner/property/unit name",
    "Long text record exists",
    "Long names",
    "Open list and review row",
    "Text remains readable without breaking the layout; truncation/tooltip behavior works if implemented.")
add("OWN-057","Special characters in owner search",
    "Owner name contains supported special characters",
    "Special-character name",
    "Search using the special-character text",
    "Search returns the correct record without errors.")
add("OWN-058","Filter + refresh",
    "Owner filter is applied",
    "Verified / property filter",
    "Apply filter → click Refresh",
    "Refresh updates data while maintaining or resetting filters according to the intended product behavior.")
add("OWN-059","Search + filter combination",
    "Search and filters are available",
    "Owner search + status/property filter",
    "Search owner → open Filters → apply status/property filter",
    "Results satisfy both search and filter criteria.")
add("OWN-060","Reset after navigation",
    "A search/filter is active",
    "Filtered owner list",
    "Apply search/filter → navigate away → return to Property Owners",
    "Search/filter state behaves according to the intended persistence rules and does not show stale results.")

# Write
for c, h in enumerate(headers, 1):
    cell = ws.cell(1, c, h)
    cell.fill = PatternFill("solid", fgColor="1F4E78")
    cell.font = Font(color="FFFFFF", bold=True)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

thin = Side(style="thin", color="D9E1F2")
for r, row in enumerate(cases, 2):
    for c, value in enumerate(row, 1):
        cell = ws.cell(r, c, value)
        cell.alignment = Alignment(vertical="top", wrap_text=True)
        cell.border = Border(bottom=thin)
    ws.row_dimensions[r].height = 55

ws.freeze_panes = "A2"
ws.auto_filter.ref = f"A1:N{ws.max_row}"

widths = {
    "A":12, "B":22, "C":40, "D":34, "E":28, "F":54,
    "G":66, "H":42, "I":16, "J":14, "K":14, "L":18, "M":26, "N":32
}
for col, width in widths.items():
    ws.column_dimensions[col].width = width

status_dv = DataValidation(type="list", formula1='"Not Started,Pass,Fail,Blocked,Not Applicable,Retest"', allow_blank=False)
priority_dv = DataValidation(type="list", formula1='"Critical,High,Medium,Low"', allow_blank=False)
ws.add_data_validation(status_dv)
ws.add_data_validation(priority_dv)
status_dv.add(f"I2:I{ws.max_row}")
priority_dv.add(f"J2:J{ws.max_row}")

ws.conditional_formatting.add(
    f"I2:I{ws.max_row}",
    FormulaRule(formula=['I2="Pass"'], fill=PatternFill("solid", fgColor="C6EFCE"))
)
ws.conditional_formatting.add(
    f"I2:I{ws.max_row}",
    FormulaRule(formula=['I2="Fail"'], fill=PatternFill("solid", fgColor="FFC7CE"))
)
ws.conditional_formatting.add(
    f"I2:I{ws.max_row}",
    FormulaRule(formula=['I2="Blocked"'], fill=PatternFill("solid", fgColor="FFEB9C"))
)
ws.conditional_formatting.add(
    f"J2:J{ws.max_row}",
    FormulaRule(formula=['J2="Critical"'], fill=PatternFill("solid", fgColor="F4CCCC"))
)

# Add a small Property Owners summary sheet
if "Owners Summary" in wb.sheetnames:
    del wb["Owners Summary"]
sm = wb.create_sheet("Owners Summary")
sm["A1"] = "Property Owners - QA Summary"
sm["A1"].font = Font(size=18, bold=True)
sm.merge_cells("A1:D1")

summary = [
    ("Total Test Cases", f"=COUNTA('Property Owners QA'!A2:A{ws.max_row})"),
    ("Passed", f'=COUNTIF(\'Property Owners QA\'!I2:I{ws.max_row},"Pass")'),
    ("Failed", f'=COUNTIF(\'Property Owners QA\'!I2:I{ws.max_row},"Fail")'),
    ("Blocked", f'=COUNTIF(\'Property Owners QA\'!I2:I{ws.max_row},"Blocked")'),
    ("Not Started", f'=COUNTIF(\'Property Owners QA\'!I2:I{ws.max_row},"Not Started")'),
    ("Pass Rate", '=IF(B2=0,0,B3/B2)'),
    ("Execution Rate", '=IF(B2=0,0,(B3+B4+B5)/B2)'),
    ("Critical Cases", f'=COUNTIF(\'Property Owners QA\'!J2:J{ws.max_row},"Critical")'),
    ("Critical Failures", f'=COUNTIFS(\'Property Owners QA\'!J2:J{ws.max_row},"Critical",\'Property Owners QA\'!I2:I{ws.max_row},"Fail")'),
]
for i, (label, formula) in enumerate(summary, 2):
    sm.cell(i,1,label).font = Font(bold=True)
    sm.cell(i,2,formula)
    sm.cell(i,1).fill = PatternFill("solid", fgColor="D9EAF7")
    sm.cell(i,1).border = Border(bottom=thin)
    sm.cell(i,2).border = Border(bottom=thin)

sm["B7"].number_format = "0.0%"
sm["B8"].number_format = "0.0%"
sm.column_dimensions["A"].width = 28
sm.column_dimensions["B"].width = 18
sm.sheet_view.showGridLines = False
ws.sheet_view.showGridLines = False

# Update original summary dashboard with the new module/case count
dash = wb["Summary Dashboard"]
# Add a note about Property Owners
note_row = max(dash.max_row + 2, 35)
dash.cell(note_row,1,"Property Owners QA")
dash.cell(note_row,1).font = Font(bold=True)
dash.cell(note_row,2,f"='Owners Summary'!B2")
dash.cell(note_row,3,"test cases added")
dash.cell(note_row,1).fill = PatternFill("solid", fgColor="D9EAF7")

wb.save(path)
print(f"Updated workbook: {path}")
print(f"Property Owners test cases added: {len(cases)}")
print(f"Total QA cases across original + Property Owners: {sum(1 for s in wb.sheetnames if s in ['QA Tracker','Property Owners QA'])}")
