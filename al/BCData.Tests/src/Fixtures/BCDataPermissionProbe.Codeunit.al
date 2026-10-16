codeunit 50211 "BCD Permission Probe"
{
    // Dedicated-container HTTP fixture only. No Permissions property; caller rights apply.
    procedure ReadError(inputJson: Text): Text
    var
        Response: JsonObject;
        Output: Text;
    begin
        ClearLastError();
        if TryRead(inputJson) then
            Error('BCD_E12_EXPECTED_READ_DENIAL');
        Response.Add('errorCode', GetLastErrorCode());
        Response.WriteTo(Output);
        exit(Output);
    end;

    [TryFunction]
    local procedure TryRead(Input: Text)
    var
        Header: Record "BCD Probe Header";
        Request: JsonObject;
        Filter: JsonObject;
        Token: JsonToken;
        Filters: JsonArray;
        FieldIds: JsonArray;
        RunId: Guid;
    begin
        // Measure the platform classification independently of the service's normalization.
        Request.ReadFrom(Input);
        Request.Get('filters', Token);
        Filters := Token.AsArray();
        Filters.Get(0, Token);
        Filter := Token.AsObject();
        Filter.Get('expression', Token);
        Evaluate(RunId, Token.AsValue().AsText());
        Header.Get(RunId, 1);
        Request.Get('fieldIds', Token);
        FieldIds := Token.AsArray();
        FieldIds.Get(0, Token);
        if Token.AsValue().AsInteger() = 11 then
            Header.CalcFields("Entry Total");
    end;

    procedure PrepareRoles(inputJson: Text): Text
    var
        PermissionSet: Record "Tenant Permission Set";
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
        RunId: Guid;
        Kind: Text;
        Kinds: List of [Text];
        Role: Code[20];
        NullGuid: Guid;
    begin
        RunId := ParseRunId(inputJson);
        Kind := 'none,header,related,filtered';
        Kinds := Kind.Split(',');
        foreach Kind in Kinds do begin
            Role := RoleId(RunId, Kind);
            if PermissionSet.Get(NullGuid, Role) then
                Error('BCD_E12_ROLE_COLLISION');
        end;
        foreach Kind in Kinds do begin
            Role := RoleId(RunId, Kind);
            PermissionSet.Init();
            PermissionSet."App ID" := NullGuid;
            PermissionSet."Role ID" := Role;
            PermissionSet.Name := 'BCD E12 ' + RunTag(RunId);
            PermissionSet.Assignable := true;
            PermissionSet.Insert();
            AddPermission(Role, 0, Database::Company, '');
            AddPermission(Role, 0, Database::"Table Metadata", '');
            AddPermission(Role, 5, Codeunit::"BCD Data Service", '');
            // Inspect the platform's untranslated read error classification, without elevation.
            AddPermission(Role, 5, Codeunit::"BCD Permission Probe", '');
            AddPermission(Role, 1, Database::"BCD Probe Header", '');
            AddPermission(Role, 1, Database::"BCD Probe Sum Entry", '');
            if Kind = 'filtered' then begin
                // Evaluate uses the same Table: Field=Filter encoding as BC's permission editor.
                AddPermission(Role, 0, Database::"BCD Probe Header",
                    Header.TableName() + ': Run ID=' + Format(RunId, 0, 4) + ',Line No.=1');
                AddPermission(Role, 0, Database::"BCD Probe Sum Entry",
                    Entry.TableName() + ': Run ID=' + Format(RunId, 0, 4) + ',Bucket=1');
            end else begin
                if Kind <> 'none' then
                    AddPermission(Role, 0, Database::"BCD Probe Header", '');
                if Kind = 'related' then
                    AddPermission(Role, 0, Database::"BCD Probe Sum Entry", '');
            end;
        end;
        exit('{"created":true}');
    end;

    procedure CleanupRoles(inputJson: Text): Text
    var
        PermissionSet: Record "Tenant Permission Set";
        Permission: Record "Tenant Permission";
        AccessControl: Record "Access Control";
        RunId: Guid;
        NullGuid: Guid;
        Kind: Text;
        Kinds: List of [Text];
        Role: Code[20];
    begin
        RunId := ParseRunId(inputJson);
        Kind := 'none,header,related,filtered';
        Kinds := Kind.Split(',');
        foreach Kind in Kinds do begin
            Role := RoleId(RunId, Kind);
            if PermissionSet.Get(NullGuid, Role) then begin
                PermissionSet.TestField(Name, 'BCD E12 ' + RunTag(RunId));
                AccessControl.SetRange("App ID", NullGuid);
                AccessControl.SetRange(Scope, AccessControl.Scope::Tenant);
                AccessControl.SetRange("Role ID", Role);
                if not AccessControl.IsEmpty() then
                    Error('BCD_E12_USERS_MUST_BE_REMOVED_FIRST');
                Permission.SetRange("App ID", NullGuid);
                Permission.SetRange("Role ID", Role);
                Permission.DeleteAll();
                PermissionSet.Delete();
            end;
        end;
        exit('{"cleaned":true}');
    end;

    local procedure AddPermission(Role: Code[20]; ObjectType: Integer; ObjectId: Integer; SecurityFilterText: Text)
    var
        Permission: Record "Tenant Permission";
    begin
        Permission.Init();
        Permission."Role ID" := Role;
        Permission."Object Type" := ObjectType;
        Permission."Object ID" := ObjectId;
        // All five fields default to Yes in this system table; clear them explicitly.
        Permission."Read Permission" := Permission."Read Permission"::" ";
        Permission."Insert Permission" := Permission."Insert Permission"::" ";
        Permission."Modify Permission" := Permission."Modify Permission"::" ";
        Permission."Delete Permission" := Permission."Delete Permission"::" ";
        Permission."Execute Permission" := Permission."Execute Permission"::" ";
        if ObjectType = 0 then
            Permission."Read Permission" := Permission."Read Permission"::Yes
        else
            Permission."Execute Permission" := Permission."Execute Permission"::Yes;
        if SecurityFilterText <> '' then
            Evaluate(Permission."Security Filter", SecurityFilterText);
        Permission.Insert();
    end;

    local procedure RunTag(RunId: Guid): Text[12]
    begin
        exit(CopyStr(DelChr(LowerCase(Format(RunId, 0, 4)), '=', '{}-'), 1, 12));
    end;

    local procedure RoleId(RunId: Guid; Kind: Text): Code[20]
    begin
        exit('BE12' + RunTag(RunId) + CopyStr(Kind, 1, 1));
    end;

    procedure Prepare(inputJson: Text): Text
    var
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
        Response: JsonObject;
        RunId: Guid;
        LineNo: Integer;
        Output: Text;
    begin
        RunId := ParseRunId(inputJson);
        for LineNo := 1 to 2 do begin
            Header.Init();
            Header."Run ID" := RunId;
            Header."Line No." := LineNo;
            if LineNo = 1 then begin
                Header."Probe Date" := 20240229D;
                Header."Probe Time" := 123456.010T;
                Evaluate(Header."Probe DateTime", '2026-10-25T01:30:00.123Z', 9);
                Evaluate(Header."Probe BigInteger", '9223372036854775807', 9);
                Header."Probe Code" := '  mixed Code  ';
            end else begin
                Header."Probe Date" := ClosingDate(20261231D);
                Header."Probe Time" := 000000T;
            end;
            Header.Insert();
            Entry.Init();
            Entry."Entry No." := 0;
            Entry."Run ID" := RunId;
            Entry."Header Line No." := 1;
            Entry.Bucket := LineNo;
            Entry.Amount := LineNo * 10;
            Entry.Insert();
        end;
        // Ask AL to encode security views instead of assembling localized filter syntax.
        Header.SetRange("Run ID", RunId);
        Header.SetRange("Line No.", 1);
        Entry.SetRange("Run ID", RunId);
        Entry.SetRange(Bucket, 1);
        Response.Add('headerSecurityFilter', Header.GetView(false));
        Response.Add('entrySecurityFilter', Entry.GetView(false));
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure Cleanup(inputJson: Text): Text
    var
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
        RunId: Guid;
    begin
        RunId := ParseRunId(inputJson);
        Entry.SetRange("Run ID", RunId);
        Entry.DeleteAll();
        Header.SetRange("Run ID", RunId);
        Header.DeleteAll();
        exit('{"cleaned":true}');
    end;

    local procedure ParseRunId(Input: Text): Guid
    var
        Request: JsonObject;
        Token: JsonToken;
        RunId: Guid;
    begin
        Request.ReadFrom(Input);
        Request.Get('runId', Token);
        Evaluate(RunId, Token.AsValue().AsText());
        if IsNullGuid(RunId) then
            Error('BCD_E12_NONEMPTY_RUN_ID_REQUIRED');
        exit(RunId);
    end;
}
