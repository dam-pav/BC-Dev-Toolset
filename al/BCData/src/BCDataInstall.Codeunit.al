codeunit 99102 "BCD Data Install"
{
    Subtype = Install;

    trigger OnInstallAppPerDatabase()
    var
        Registration: Codeunit "BCD Service Registration";
    begin
        Registration.RegisterService();
    end;
}
