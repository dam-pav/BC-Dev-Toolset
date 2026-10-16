permissionset 50100 "BCD DATA EXECUTE"
{
    Assignable = true;
    Caption = 'BC Data service execution';
    Permissions = codeunit "BCD Data Service" = X;
    // No blanket business-table permissions. Caller permissions remain authoritative.
}
