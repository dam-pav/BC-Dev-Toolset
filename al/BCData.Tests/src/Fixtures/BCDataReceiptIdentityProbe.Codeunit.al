codeunit 50215 "BCD Receipt Identity Probe"
{
    // Test administration only. Restricted roles cannot execute this object.
    // No Permissions property: native User/Tenant Permission rights are required.
    procedure PrepareRoles(inputJson: Text): Text
    var
        Role: Record "Tenant Permission Set";
        Receipt: Record "BCD Receipt Fixture";
        Objects: Record AllObjWithCaption;
        NamespaceId: Guid;
        Principal: Guid;
        Profile: Text;
        Profiles: List of [Text];
        NullGuid: Guid;
    begin
        NamespaceId := GetGuid(inputJson, 'namespaceId');
        Profiles := ProfileList();
        foreach Profile in Profiles do
            if Role.Get(NullGuid, RoleId(NamespaceId, Profile)) then
                Error('BCD_E6P_ROLE_COLLISION');
        foreach Profile in Profiles do begin
            Principal := ProfilePrincipal(NamespaceId, Profile, true);
            Role.Init();
            Role."App ID" := NullGuid;
            Role."Role ID" := RoleId(NamespaceId, Profile);
            Role.Name := 'BCD E6P ' + Tag(NamespaceId);
            Role.Assignable := true;
            Role.Insert();
            AddPermission(Role."Role ID", 0, Database::Company, 'R', '');
            AddPermission(Role."Role ID", 5, Codeunit::"BCD Receipt Probe", '', '');
            // BC23's insert path invokes this Base Application subscriber even for
            // these unmapped fixture tables. Execution only; no extra table-data rights.
            AddPermission(Role."Role ID", 5, 7233, '', '');
            // Newer Base Application initialization also requires execution. Keep
            // this version-specific prerequisite conditional on the installed object.
            Objects.SetRange("Object Type", Objects."Object Type"::Codeunit);
            Objects.SetRange("Object ID", 36951);
            Objects.SetRange("Object Name", 'Initialization');
            if not Objects.IsEmpty() then
                AddPermission(Role."Role ID", 5, 36951, '', '');
            AddPermission(Role."Role ID", 1, Database::"BCD Receipt Run", '', '');
            AddPermission(Role."Role ID", 1, Database::"BCD Receipt Fixture", '', '');
            case Profile of
                'm', 'fm': AddPermission(Role."Role ID", 0, Database::"BCD Receipt Run", 'RID', '');
                'fn': AddPermission(Role."Role ID", 0, Database::"BCD Receipt Run", 'IMD', '');
                else AddPermission(Role."Role ID", 0, Database::"BCD Receipt Run", 'RIMD', '');
            end;
            if Profile <> 'n' then
                if Profile in ['r', 'fr'] then
                    AddPermission(Role."Role ID", 0, Database::"BCD Receipt Fixture", 'R',
                        Receipt.TableName() + ': Principal=' + Format(Principal, 0, 4))
                else
                    AddPermission(Role."Role ID", 0, Database::"BCD Receipt Fixture", 'RIMD',
                        Receipt.TableName() + ': Principal=' + Format(Principal, 0, 4));
        end;
        exit('{"created":true}');
    end;

    procedure CleanupRoles(inputJson: Text): Text
    var
        Role: Record "Tenant Permission Set";
        Permission: Record "Tenant Permission";
        AccessControl: Record "Access Control";
        NamespaceId: Guid;
        Profile: Text;
        Profiles: List of [Text];
        NullGuid: Guid;
    begin
        NamespaceId := GetGuid(inputJson, 'namespaceId');
        Profiles := ProfileList();
        foreach Profile in Profiles do
            if Role.Get(NullGuid, RoleId(NamespaceId, Profile)) then begin
                Role.TestField(Name, 'BCD E6P ' + Tag(NamespaceId));
                AccessControl.SetRange("App ID", NullGuid);
                AccessControl.SetRange(Scope, AccessControl.Scope::Tenant);
                AccessControl.SetRange("Role ID", Role."Role ID");
                if not AccessControl.IsEmpty() then
                    Error('BCD_E6P_REMOVE_USERS_FIRST');
                Permission.SetRange("App ID", NullGuid);
                Permission.SetRange("Role ID", Role."Role ID");
                Permission.DeleteAll();
                Role.Delete();
            end;
        exit('{"cleaned":true}');
    end;

    procedure DataState(inputJson: Text): Text
    begin
        exit(DataStateOrCleanup(inputJson, false));
    end;

    procedure CleanupData(inputJson: Text): Text
    begin
        exit(DataStateOrCleanup(inputJson, true));
    end;

    local procedure DataStateOrCleanup(Input: Text; DeleteData: Boolean): Text
    var
        Run: Record "BCD Receipt Run";
        Receipt: Record "BCD Receipt Fixture";
        Request: JsonObject;
        Item: JsonObject;
        Row: JsonObject;
        Response: JsonObject;
        Items: JsonArray;
        Rows: JsonArray;
        Token: JsonToken;
        NamespaceId: Guid;
        RunId: Guid;
        Principal: Guid;
        Kind: Text;
        Exists: Boolean;
        Output: Text;
    begin
        NamespaceId := GetGuid(Input, 'namespaceId');
        Request.ReadFrom(Input);
        Request.Get('runs', Token);
        Items := Token.AsArray();
        if Items.Count() <> 5 then
            Error('BCD_E6P_INVALID_RUNS');
        foreach Token in Items do begin
            Item := Token.AsObject();
            Item.Get('kind', Token);
            Kind := Token.AsValue().AsText();
            if not (Kind in ['f', 'x', 'n', 'm', 'r']) then
                Error('BCD_E6P_INVALID_KIND');
            Item.WriteTo(Output);
            RunId := GetGuid(Output, 'runId');
            Principal := ProfilePrincipal(NamespaceId, Kind, false);
            Clear(Run);
            Exists := Run.Get(RunId);
            Receipt.Reset();
            Receipt.SetRange("Run ID", RunId);
            if Exists then begin
                if IsNullGuid(Principal) or (Run.Principal <> Principal) then
                    Error('BCD_E6P_DATA_OWNER_CHANGED');
                if Receipt.FindSet() then
                    repeat
                        if Receipt.Principal <> Principal then
                            Error('BCD_E6P_RECEIPT_OWNER_CHANGED');
                    until Receipt.Next() = 0;
            end else
                if not Receipt.IsEmpty() then
                    Error('BCD_E6P_ORPHAN_RECEIPT');
            if DeleteData and Exists then begin
                Receipt.DeleteAll();
                Run.Delete();
                Exists := false;
            end;
            Clear(Row);
            Row.Add('kind', Kind);
            Row.Add('runExists', Exists);
            Row.Add('receiptCount', Receipt.Count());
            Row.Add('total', Run.Total);
            Row.Add('applyCount', Run."Apply Count");
            Rows.Add(Row);
        end;
        Response.Add('rows', Rows);
        Response.WriteTo(Output);
        exit(Output);
    end;

    local procedure AddPermission(RoleId: Code[20]; ObjectType: Integer; ObjectId: Integer; Rights: Text; Filter: Text)
    var
        Permission: Record "Tenant Permission";
    begin
        Permission.Init();
        Permission."Role ID" := RoleId;
        Permission."Object Type" := ObjectType;
        Permission."Object ID" := ObjectId;
        Permission."Read Permission" := Permission."Read Permission"::" ";
        Permission."Insert Permission" := Permission."Insert Permission"::" ";
        Permission."Modify Permission" := Permission."Modify Permission"::" ";
        Permission."Delete Permission" := Permission."Delete Permission"::" ";
        Permission."Execute Permission" := Permission."Execute Permission"::" ";
        if StrPos(Rights, 'R') > 0 then Permission."Read Permission" := Permission."Read Permission"::Yes;
        if StrPos(Rights, 'I') > 0 then Permission."Insert Permission" := Permission."Insert Permission"::Yes;
        if StrPos(Rights, 'M') > 0 then Permission."Modify Permission" := Permission."Modify Permission"::Yes;
        if StrPos(Rights, 'D') > 0 then Permission."Delete Permission" := Permission."Delete Permission"::Yes;
        if ObjectType <> 0 then Permission."Execute Permission" := Permission."Execute Permission"::Yes;
        if Filter <> '' then Evaluate(Permission."Security Filter", Filter);
        Permission.Insert();
    end;

    local procedure ProfileList(): List of [Text]
    var
        TextValue: Text;
    begin
        TextValue := 'f,x,n,m,r,fm,fr,fn';
        exit(TextValue.Split(','));
    end;

    local procedure ProfilePrincipal(NamespaceId: Guid; Profile: Text; Required: Boolean): Guid
    var
        User: Record User;
        Kind: Text;
        NullGuid: Guid;
    begin
        Kind := Profile;
        if Profile in ['fm', 'fr', 'fn'] then Kind := 'f';
        User.SetRange("User Name", 'bcd_e6p_' + Tag(NamespaceId) + '_' + Kind);
        if not User.FindFirst() then begin
            if Required then Error('BCD_E6P_USER_MISSING');
            exit(NullGuid);
        end;
        if LowerCase(User."Full Name") <> LowerCase('BCD E6P ' + Format(NamespaceId, 0, 4)) then
            Error('BCD_E6P_USER_OWNER_CHANGED');
        exit(User."User Security ID");
    end;

    local procedure RoleId(NamespaceId: Guid; Profile: Text): Code[20]
    begin
        exit('BE6P' + Tag(NamespaceId) + Profile);
    end;

    local procedure Tag(Id: Guid): Text[12]
    begin
        exit(CopyStr(DelChr(LowerCase(Format(Id, 0, 4)), '=', '{}-'), 1, 12));
    end;

    local procedure GetGuid(Input: Text; Name: Text): Guid
    var
        Request: JsonObject;
        Token: JsonToken;
        Id: Guid;
    begin
        Request.ReadFrom(Input);
        Request.Get(Name, Token);
        if not Evaluate(Id, Token.AsValue().AsText()) then Error('BCD_E6P_INVALID_ID');
        if IsNullGuid(Id) then Error('BCD_E6P_INVALID_ID');
        exit(Id);
    end;
}
