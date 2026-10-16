// Test-only table rights. Permissions Mock adds object execution, never table data.
permissionset 50200 "BCD TEST SETUP"
{
    Assignable = false;
    Permissions = tabledata "BCD Probe Header" = RIMD,
                  tabledata "BCD Probe Sum Entry" = RIMD,
                  tabledata "Table Metadata" = R;
}

permissionset 50201 "BCD TEST NONE"
{
    Assignable = false;
    Permissions = tabledata "Table Metadata" = R,
                  tabledata Company = R;
}

permissionset 50202 "BCD TEST HEADER R"
{
    Assignable = false;
    IncludedPermissionSets = "BCD TEST NONE";
    Permissions = tabledata "BCD Probe Header" = R;
}

permissionset 50203 "BCD TEST RELATED R"
{
    Assignable = false;
    IncludedPermissionSets = "BCD TEST HEADER R";
    Permissions = tabledata "BCD Probe Sum Entry" = R;
}
