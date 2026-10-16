codeunit 50101 "BCD Service Registration"
{
    Access = Internal;

    procedure RegisterService()
    var
        WebService: Record "Tenant Web Service";
        Management: Codeunit "Web Service Management";
    begin
        WebService.SetRange("Service Name", 'BCDData');
        if WebService.FindFirst() then
            if (WebService."Object Type" <> WebService."Object Type"::Codeunit) or
               (WebService."Object ID" <> Codeunit::"BCD Data Service") then
                Error('BCD_REGISTRATION_CONFLICT: BCDData belongs to another service.');
        Management.CreateTenantWebService(WebService."Object Type"::Codeunit, Codeunit::"BCD Data Service", 'BCDData', true);
    end;
}
