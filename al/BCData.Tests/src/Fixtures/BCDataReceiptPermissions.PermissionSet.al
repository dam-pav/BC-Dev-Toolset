permissionset 50204 "BCD RECEIPT SETUP"
{
    Assignable = false;
    Permissions = tabledata "BCD Receipt Run" = RIMD,
                  tabledata "BCD Receipt Fixture" = RIMD;
}
permissionset 50205 "BCD RECEIPT NONE"
{
    Assignable = false;
    Permissions = tabledata "BCD Receipt Run" = RIMD;
}
permissionset 50206 "BCD RECEIPT RUN R"
{
    Assignable = false;
    Permissions = tabledata "BCD Receipt Run" = R,
                  tabledata "BCD Receipt Fixture" = RIMD;
}
permissionset 50207 "BCD RECEIPT R"
{
    Assignable = false;
    Permissions = tabledata "BCD Receipt Run" = RIMD,
                  tabledata "BCD Receipt Fixture" = R;
}
permissionset 50208 "BCD RECEIPT NO RUN R"
{
    Assignable = false;
    Permissions = tabledata "BCD Receipt Run" = IMD,
                  tabledata "BCD Receipt Fixture" = RIMD;
}
