permissionset 99101 "BCD DATA WRITE"
{
    Assignable = true;
    Caption = 'BC Data mutation service';
    Permissions = codeunit "BCD Mutation Service" = X,
                  codeunit "BCD Mutation Coordinator" = X,
                  codeunit "BCD Record Mutation" = X,
                  codeunit "BCD Field Input" = X,
                  codeunit "BCD Data Service" = X,
                  tabledata "BCD Mutation Receipt" = RIMD;
    // Separate opt-in grant. No business-table rights or elevated Permissions.
    // Generic data tools cannot read or mutate the companion's receipt table.
}
