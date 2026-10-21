codeunit 99103 "BCD Data Upgrade"
{
    Subtype = Upgrade;

    trigger OnUpgradePerDatabase()
    var
        Registration: Codeunit "BCD Service Registration";
    begin
        Registration.RegisterUpgradedService();
    end;
}
