permissionset 50240 "BCD COORD SETUP"
{
    Assignable = false;
    Permissions = tabledata "Table Metadata" = R,
                  tabledata Company = R,
                  tabledata "BCD Mutation Receipt" = RIMD,
                  tabledata "BCD Mutation Fixture" = RIMD,
                  tabledata "BCD Mutation Trigger Log" = RIMD;
}

permissionset 50241 "BCD COORD REPLAY"
{
    Assignable = false;
    Permissions = tabledata "BCD Mutation Receipt" = R,
                  tabledata "BCD Mutation Fixture" = R;
}

permissionset 50242 "BCD COORD NO TARGET"
{
    Assignable = false;
    Permissions = tabledata "BCD Mutation Receipt" = R;
}

permissionset 50243 "BCD COORD NO RCPT R"
{
    Assignable = false;
    Permissions = tabledata "BCD Mutation Receipt" = IMD,
                  tabledata "BCD Mutation Fixture" = RIMD;
}

permissionset 50244 "BCD COORD NO ANCHOR"
{
    Assignable = false;
    Permissions = tabledata "BCD Mutation Receipt" = R,
                  tabledata "BCD Mutation Fixture" = RIMD;
}

permissionset 50245 "BCD COORD TARGET R"
{
    Assignable = false;
    Permissions = tabledata "Table Metadata" = R,
                  tabledata Company = R,
                  tabledata "BCD Mutation Receipt" = RIMD,
                  tabledata "BCD Mutation Fixture" = R,
                  tabledata "BCD Mutation Trigger Log" = RIMD;
}
