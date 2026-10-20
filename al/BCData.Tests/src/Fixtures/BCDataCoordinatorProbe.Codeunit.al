codeunit 50226 "BCD Coordinator Probe"
{
    // Test app only. Fixed fixture table/keys; no arbitrary table or field input.
    // No Permissions elevation; HTTP harness uses the dedicated test administrator.
    procedure Prepare(inputJson: Text): Text
    var
        Run: Record "BCD Coordinator Run";
        Row: Record "BCD Mutation Fixture";
        Input: JsonObject;
        Token: JsonToken;
    begin
        Input.ReadFrom(inputJson);
        Run."Run ID" := ReadGuid(Input, 'runId');
        if IsNullGuid(Run."Run ID") then
            Error('BCD_COORD_RUN_REQUIRED');
        Input.Get('operation', Token);
        Run.Operation := CopyStr(Token.AsValue().AsText(), 1, MaxStrLen(Run.Operation));
        if not (Run.Operation in ['insert', 'modify', 'rename', 'delete']) then
            Error('BCD_COORD_OPERATION');
        Run.Principal := UserSecurityId();
        Run."Primary Request ID" := Run."Run ID";
        if Input.Contains('requestId') then
            Run."Primary Request ID" := ReadGuid(Input, 'requestId');
        Run."Delay Milliseconds" := 3000;
        if Input.Get('delayMs', Token) then
            Run."Delay Milliseconds" := Token.AsValue().AsInteger();
        if not (Run."Delay Milliseconds" in [0, 3000]) then
            Error('BCD_COORD_DELAY');
        Run."Other Request ID" := CreateGuid();
        Run.Insert();
        Run."First Epoch" := PreparedEpoch(Coordinator.Prepare(Run."Primary Request ID"));
        Run."Other Epoch" := PreparedEpoch(Coordinator.Prepare(Run."Other Request ID"));
        if Run.Operation <> 'insert' then begin
            Row.Init();
            Row."Run ID" := Run."Run ID";
            Row.Name := 'A';
            Row.Sequence := 1;
            Row.Insert(true);
            // Arm delay AFTER setup, without firing a business trigger.
            Row."Delay Milliseconds" := Run."Delay Milliseconds";
            Row.Modify(false);
            Run."Target ID" := Row.SystemId;
        end;
        Run.Modify();
        exit(Inspect(inputJson));
    end;

    [CommitBehavior(CommitBehavior::Error)]
    procedure Execute(inputJson: Text): Text
    var
        Run: Record "BCD Coordinator Run";
        Input: JsonObject;
        Request: JsonObject;
        Fields: JsonArray;
        Token: JsonToken;
        RequestId: Guid;
        Epoch: Guid;
        TargetId: Guid;
        AllowedTargetId: Guid;
        Destination: Text;
        Output: Text;
    begin
        LoadOwned(inputJson, Run, Input);
        RequestId := RequestFor(Input, Run);
        Epoch := ReadGuid(Input, 'epoch');
        Request.Add('operation', Run.Operation);
        Request.Add('tableId', Database::"BCD Mutation Fixture");
        if Run.Operation <> 'insert' then begin
            TargetId := ReadGuid(Input, 'systemId');
            AllowedTargetId := Run."Target ID";
            if (RequestId = Run."Other Request ID") and not IsNullGuid(Run."Replacement ID") then
                AllowedTargetId := Run."Replacement ID";
            if TargetId <> AllowedTargetId then
                Error('BCD_COORD_TARGET');
            Request.Add('systemId', Format(TargetId, 0, 4));
            Input.Get('expectedVersion', Token);
            Request.Add('expectedVersion', Token);
        end;
        case Run.Operation of
            'insert':
                begin
                    AddField(Fields, 1, Format(Run."Run ID", 0, 4));
                    AddField(Fields, 2, 'A');
                    AddField(Fields, 3, 1);
                    AddField(Fields, 23, Run."Delay Milliseconds");
                    Input.Get('quantity', Token);
                    AddField(Fields, 4, Token.AsValue().AsText());
                    Request.Add('fields', Fields);
                end;
            'modify':
                begin
                    Input.Get('quantity', Token);
                    AddField(Fields, 4, Token.AsValue().AsText());
                    Request.Add('fields', Fields);
                end;
            'rename':
                begin
                    Input.Get('destination', Token);
                    Destination := Token.AsValue().AsText();
                    if not (Destination in ['B', 'C']) then
                        Error('BCD_COORD_DESTINATION');
                    AddField(Fields, 1, Format(Run."Run ID", 0, 4));
                    AddField(Fields, 2, Destination);
                    AddField(Fields, 3, 1);
                    Request.Add('primaryKey', Fields);
                end;
        end;
        Request.WriteTo(Output);
        exit(Coordinator.Execute(RequestId, Epoch, Output));
    end;

    procedure Observe(inputJson: Text): Text
    var
        Run: Record "BCD Coordinator Run";
        Receipt: Record "BCD Mutation Receipt";
        Input: JsonObject;
        Response: JsonObject;
    begin
        LoadOwned(inputJson, Run, Input);
        // Dirty reads are ONLY fixture observation, never execution authorization.
        SelectLatestVersion();
        Receipt.ReadIsolation := IsolationLevel::ReadUncommitted;
        Receipt.SetRange(Principal, UserSecurityId());
        Receipt.SetRange("Request ID", RequestFor(Input, Run));
        if not Receipt.FindFirst() then
            Error('BCD_COORD_RECEIPT_REQUIRED');
        Response.Add('pending', (Receipt."Owner Session ID" > 0) and not Receipt.Completed);
        Response.Add('completed', Receipt.Completed);
        Response.Add('ownerSessionId', Receipt."Owner Session ID");
        Response.Add('observerSessionId', SessionId());
        exit(ToText(Response));
    end;

    procedure Inspect(inputJson: Text): Text
    var
        Run: Record "BCD Coordinator Run";
        Row: Record "BCD Mutation Fixture";
        Receipt: Record "BCD Mutation Receipt";
        Entry: Record "BCD Mutation Trigger Log";
        Input: JsonObject;
        Response: JsonObject;
    begin
        LoadOwned(inputJson, Run, Input);
        Response.Add('epoch', Format(Run."First Epoch", 0, 4));
        Response.Add('otherEpoch', Format(Run."Other Epoch", 0, 4));
        Response.Add('otherRequestId', Format(Run."Other Request ID", 0, 4));
        Response.Add('primaryRequestId', Format(Run."Primary Request ID", 0, 4));
        Row.ReadIsolation := IsolationLevel::ReadCommitted;
        Row.SetRange("Run ID", Run."Run ID");
        Response.Add('rows', Row.Count());
        if Row.FindFirst() then begin
            Response.Add('systemId', Format(Row.SystemId, 0, 4));
            Response.Add('version', Format(Row.SystemRowVersion, 0, 9));
            Response.Add('name', Row.Name);
            Response.Add('quantity', Format(Row.Quantity, 0, 9));
            Response.Add('insertCount', Row."Insert Count");
            Response.Add('modifyCount', Row."Modify Count");
        end;
        Entry.SetRange("Run ID", Run."Run ID");
        Response.Add('logs', Entry.Count());
        Receipt.ReadIsolation := IsolationLevel::ReadCommitted;
        Receipt.Get(UserSecurityId(), Run."Primary Request ID");
        Response.Add('completed', Receipt.Completed);
        Receipt.Get(UserSecurityId(), Run."Other Request ID");
        Response.Add('otherCompleted', Receipt.Completed);
        exit(ToText(Response));
    end;

    procedure Cleanup(inputJson: Text): Text
    var
        Run: Record "BCD Coordinator Run";
        Row: Record "BCD Mutation Fixture";
        Receipt: Record "BCD Mutation Receipt";
        Entry: Record "BCD Mutation Trigger Log";
        Input: JsonObject;
    begin
        LoadOwned(inputJson, Run, Input);
        Receipt.Get(UserSecurityId(), Run."Primary Request ID");
        Receipt.Delete();
        Receipt.Get(UserSecurityId(), Run."Other Request ID");
        Receipt.Delete();
        Row.SetRange("Run ID", Run."Run ID");
        Row.DeleteAll();
        Entry.SetRange("Run ID", Run."Run ID");
        Entry.DeleteAll();
        Run.Delete();
        exit('{"cleaned":true}');
    end;

    procedure CleanState(inputJson: Text): Text
    var
        Run: Record "BCD Coordinator Run";
        Row: Record "BCD Mutation Fixture";
        Entry: Record "BCD Mutation Trigger Log";
        Receipt: Record "BCD Mutation Receipt";
        Input: JsonObject;
        Response: JsonObject;
        RunId: Guid;
    begin
        Input.ReadFrom(inputJson);
        RunId := ReadGuid(Input, 'runId');
        Row.SetRange("Run ID", RunId);
        Entry.SetRange("Run ID", RunId);
        Response.Add('runExists', Run.Get(RunId));
        Response.Add('rows', Row.Count());
        Response.Add('logs', Entry.Count());
        if Input.Contains('primaryRequestId') then
            Response.Add('receiptExists', Receipt.Get(UserSecurityId(), ReadGuid(Input, 'primaryRequestId')))
        else
            Response.Add('receiptExists', Receipt.Get(UserSecurityId(), RunId));
        // Caller supplies the recorded secondary GUID for independent cleanup check.
        Response.Add('otherReceiptExists', Receipt.Get(UserSecurityId(), ReadGuid(Input, 'otherRequestId')));
        exit(ToText(Response));
    end;

    local procedure LoadOwned(InputText: Text; var Run: Record "BCD Coordinator Run"; var Input: JsonObject)
    begin
        Input.ReadFrom(InputText);
        Run.Get(ReadGuid(Input, 'runId'));
        if Run.Principal <> UserSecurityId() then
            Error('BCD_COORD_OWNER');
    end;

    local procedure RequestFor(Input: JsonObject; Run: Record "BCD Coordinator Run"): Guid
    var
        Token: JsonToken;
    begin
        if not Input.Get('slot', Token) then
            exit(Run."Primary Request ID");
        case Token.AsValue().AsInteger() of
            1: exit(Run."Primary Request ID");
            2: exit(Run."Other Request ID");
        end;
        Error('BCD_COORD_SLOT');
    end;

    local procedure ReadGuid(Input: JsonObject; Name: Text): Guid
    var
        Token: JsonToken;
        Value: Guid;
    begin
        Input.Get(Name, Token);
        if not Evaluate(Value, Token.AsValue().AsText()) or IsNullGuid(Value) then
            Error('BCD_COORD_GUID');
        exit(Value);
    end;

    local procedure PreparedEpoch(Prepared: Text): Guid
    var
        Input: JsonObject;
    begin
        Input.ReadFrom(Prepared);
        exit(ReadGuid(Input, 'epoch'));
    end;

    local procedure AddField(var Fields: JsonArray; FieldId: Integer; Value: Variant)
    var
        Assignment: JsonObject;
        IntegerValue: Integer;
        TextValue: Text;
    begin
        Assignment.Add('fieldId', FieldId);
        // Preserve the actual JSON scalar type rather than Format coercion.
        if Value.IsInteger then begin
            IntegerValue := Value;
            Assignment.Add('value', IntegerValue);
        end else begin
            TextValue := Value;
            Assignment.Add('value', TextValue);
        end;
        Fields.Add(Assignment);
    end;

    local procedure ToText(Response: JsonObject): Text
    var
        Output: Text;
    begin
        Response.WriteTo(Output);
        exit(Output);
    end;

    var
        Coordinator: Codeunit "BCD Mutation Coordinator";
}
