codeunit 99101 "BCD Service Registration"
{
    Access = Internal;

    procedure RegisterService()
    begin
        Register('BCDData', Codeunit::"BCD Data Service");
        Register('BCDDataWrite', Codeunit::"BCD Mutation Service");
    end;

    local procedure Register(ServiceName: Text[240]; ObjectId: Integer)
    var
        WebService: Record "Tenant Web Service";
        Management: Codeunit "Web Service Management";
    begin
        WebService.SetRange("Service Name", ServiceName);
        if WebService.FindFirst() then
            if (WebService."Object Type" <> WebService."Object Type"::Codeunit) or
               (WebService."Object ID" <> ObjectId) then
                Error('BCD_REGISTRATION_CONFLICT: %1 belongs to another service.', ServiceName);
        Management.CreateTenantWebService(WebService."Object Type"::Codeunit, ObjectId, ServiceName, true);
    end;
}
