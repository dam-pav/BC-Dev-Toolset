permissionset 50209 "BCD EV SETUP"
{
    Assignable = false;
    Permissions = tabledata "BCD Receipt Run" = RIMD,
                  tabledata "BCD Receipt Fixture" = RIMD,
                  tabledata "BCD Conflict Fixture" = RIMD,
                  tabledata "BCD Conflict Barrier" = RIMD;
}
permissionset 50210 "BCD EV TARGET R"
{
    Assignable = false;
    Permissions = tabledata "BCD Receipt Run" = RIMD,
                  tabledata "BCD Receipt Fixture" = RIMD,
                  tabledata "BCD Conflict Fixture" = R,
                  tabledata "BCD Conflict Barrier" = RIMD;
}
permissionset 50211 "BCD EV NO TARGET R"
{
    Assignable = false;
    Permissions = tabledata "BCD Receipt Run" = RIMD,
                  tabledata "BCD Receipt Fixture" = RIMD,
                  tabledata "BCD Conflict Fixture" = IMD,
                  tabledata "BCD Conflict Barrier" = RIMD;
}
