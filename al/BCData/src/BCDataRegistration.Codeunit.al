codeunit 99101 "BCD Service Registration"
{
    Access = Internal;

    procedure RegisterService()
    begin
        Register('BCDData', Codeunit::"BCD Data Service", 0);
        Register('BCDDataWrite', Codeunit::"BCD Mutation Service", 0);
    end;

    procedure RegisterUpgradedService()
    begin
        // Only the upgrade lifecycle may replace the two known pre-0.1.11 bindings.
        Register('BCDData', Codeunit::"BCD Data Service", 50100);
        Register('BCDDataWrite', Codeunit::"BCD Mutation Service", 50107);
    end;

    local procedure Register(ServiceName: Text[240]; ObjectId: Integer; PreviousObjectId: Integer)
    var
        WebService: Record "Tenant Web Service";
        Management: Codeunit "Web Service Management";
    begin
        WebService.SetRange("Service Name", ServiceName);
        if WebService.FindFirst() then begin
            if (WebService."Object Type" <> WebService."Object Type"::Codeunit) or
               ((WebService."Object ID" <> ObjectId) and
                ((PreviousObjectId = 0) or (WebService."Object ID" <> PreviousObjectId))) then
                Error('BCD_REGISTRATION_CONFLICT: %1 belongs to another service.', ServiceName);
            if WebService."Object ID" <> ObjectId then begin
                WebService."Object ID" := ObjectId;
                WebService.Modify();
            end;
        end;
        Management.CreateTenantWebService(WebService."Object Type"::Codeunit, ObjectId, ServiceName, true);
    end;
}
