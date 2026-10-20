permissionset 50230 "BCD GEN SETUP"
{
    Assignable = false;
    Permissions = tabledata "Table Metadata" = R,
                  tabledata Company = R,
                  tabledata "BCD Mutation Fixture" = RIMD,
                  tabledata "BCD Mutation Trigger Log" = RIMD;
}

permissionset 50231 "BCD GEN R"
{
    Assignable = false;
    Permissions = tabledata "Table Metadata" = R,
                  tabledata Company = R,
                  tabledata "BCD Mutation Fixture" = R,
                  tabledata "BCD Mutation Trigger Log" = RIMD;
}

permissionset 50232 "BCD GEN RI"
{
    Assignable = false;
    Permissions = tabledata "Table Metadata" = R,
                  tabledata Company = R,
                  tabledata "BCD Mutation Fixture" = RI,
                  tabledata "BCD Mutation Trigger Log" = RIMD;
}

permissionset 50233 "BCD GEN RM"
{
    Assignable = false;
    Permissions = tabledata "Table Metadata" = R,
                  tabledata Company = R,
                  tabledata "BCD Mutation Fixture" = RM,
                  tabledata "BCD Mutation Trigger Log" = RIMD;
}

permissionset 50234 "BCD GEN RD"
{
    Assignable = false;
    Permissions = tabledata "Table Metadata" = R,
                  tabledata Company = R,
                  tabledata "BCD Mutation Fixture" = RD,
                  tabledata "BCD Mutation Trigger Log" = RIMD;
}

permissionset 50235 "BCD GEN NO READ"
{
    Assignable = false;
    Permissions = tabledata "Table Metadata" = R,
                  tabledata Company = R,
                  tabledata "BCD Mutation Fixture" = IMD,
                  tabledata "BCD Mutation Trigger Log" = RIMD;
}

permissionset 50236 "BCD GEN NO LOG I"
{
    Assignable = false;
    Permissions = tabledata "Table Metadata" = R,
                  tabledata Company = R,
                  tabledata "BCD Mutation Fixture" = RIMD,
                  tabledata "BCD Mutation Trigger Log" = R;
}
