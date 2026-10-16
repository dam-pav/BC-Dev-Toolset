codeunit 50214 "BCD Receipt Probe"
{
    // E06 test fixture only. No Permissions property; no production receipt contract.
    procedure Prepare(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
    begin
        Run."Run ID" := ParseGuid(inputJson, 'runId');
        Run.Principal := UserSecurityId();
        Run.Insert();
        exit('{"prepared":true}');
    end;

    [CommitBehavior(CommitBehavior::Error)]
    procedure Execute(inputJson: Text): Text
    var
        Receipt: Record "BCD Receipt Fixture";
        Run: Record "BCD Receipt Run";
        Request: JsonObject;
        Token: JsonToken;
        ResultObject: JsonObject;
        RunId: Guid;
        RequestId: Guid;
        Amount: Integer;
        DelayMs: Integer;
        FailAfterMutation: Boolean;
        Payload: Text;
        ResultText: Text;
    begin
        RunId := ParseGuid(inputJson, 'runId');
        RequestId := ParseGuid(inputJson, 'requestId');
        CheckOwner(RunId);
        Request.ReadFrom(inputJson);
        Request.Get('amount', Token);
        Amount := Token.AsValue().AsInteger();
        if (Amount < -1000000) or (Amount > 1000000) then
            Error('BCD_E06_AMOUNT_RANGE');
        if Request.Get('delayMs', Token) then
            DelayMs := Token.AsValue().AsInteger();
        if (DelayMs < 0) or (DelayMs > 5000) then
            Error('BCD_E06_DELAY_RANGE');
        if Request.Get('failAfterMutation', Token) then
            FailAfterMutation := Token.AsValue().AsBoolean();
        // Delay/failure are fixture fault injection, not part of the mutation payload.
        Payload := 'add|' + Format(Amount, 0, 9);
        Receipt.Init();
        Receipt."Run ID" := RunId;
        Receipt.Principal := UserSecurityId();
        Receipt."Request ID" := RequestId;
        Receipt.Payload := CopyStr(Payload, 1, MaxStrLen(Receipt.Payload));
        Receipt."Owner Session ID" := SessionId();
        // The unique-key insert must happen before mutation code. Duplicate insert waits
        // for the owner, then the stored result is read with committed isolation.
        if not Receipt.Insert() then begin
            Receipt.ReadIsolation := IsolationLevel::ReadCommitted;
            Receipt.Get(RunId, UserSecurityId(), RequestId);
            if Receipt.Payload <> Payload then
                Error('BCD_E06_REQUEST_ID_REUSED');
            if not Receipt.Completed then
                Error('BCD_E06_INCOMPLETE_RECEIPT');
            exit(Receipt.Result);
        end;
        if DelayMs > 0 then
            Sleep(DelayMs);
        Run.LockTable();
        Run.Get(RunId);
        Run.Total += Amount;
        Run."Apply Count" += 1;
        Run.Modify();
        if FailAfterMutation then
            Error('BCD_E06_AFTER_MUTATION');
        ResultObject.Add('requestId', Format(RequestId, 0, 4));
        ResultObject.Add('resultId', Format(CreateGuid(), 0, 4));
        ResultObject.Add('amount', Amount);
        ResultObject.Add('total', Run.Total);
        ResultObject.Add('applyCount', Run."Apply Count");
        ResultObject.Add('ownerSessionId', Receipt."Owner Session ID");
        ResultObject.WriteTo(ResultText);
        Receipt.Result := CopyStr(ResultText, 1, MaxStrLen(Receipt.Result));
        Receipt.Completed := true;
        Receipt.Modify();
        exit(ResultText);
    end;

    procedure Inspect(inputJson: Text): Text
    var
        Receipt: Record "BCD Receipt Fixture";
        Run: Record "BCD Receipt Run";
        Response: JsonObject;
        RunId: Guid;
        Output: Text;
    begin
        RunId := ParseGuid(inputJson, 'runId');
        CheckOwner(RunId);
        Run.ReadIsolation := IsolationLevel::ReadCommitted;
        Run.Get(RunId);
        Receipt.ReadIsolation := IsolationLevel::ReadCommitted;
        Receipt.SetRange("Run ID", RunId);
        Receipt.SetRange(Principal, UserSecurityId());
        Response.Add('total', Run.Total);
        Response.Add('applyCount', Run."Apply Count");
        Response.Add('receiptCount', Receipt.Count());
        Receipt.SetRange(Completed, false);
        Response.Add('pendingCount', Receipt.Count());
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure ObservePending(inputJson: Text): Text
    var
        Receipt: Record "BCD Receipt Fixture";
        Response: JsonObject;
        RunId: Guid;
        Found: Boolean;
        Output: Text;
    begin
        RunId := ParseGuid(inputJson, 'runId');
        CheckOwner(RunId);
        // Test-only dirty read proves overlapping service sessions; never used for replay.
        // Clear cached misses so polling can observe an insert that is still uncommitted.
        SelectLatestVersion();
        Receipt.ReadIsolation := IsolationLevel::ReadUncommitted;
        Receipt.SetRange("Run ID", RunId);
        Receipt.SetRange(Principal, UserSecurityId());
        Receipt.SetRange("Request ID", ParseGuid(inputJson, 'requestId'));
        Found := Receipt.FindFirst();
        Response.Add('found', Found);
        Response.Add('completed', Found and Receipt.Completed);
        Response.Add('ownerSessionId', Receipt."Owner Session ID");
        Response.Add('observerSessionId', SessionId());
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure ReceiptVisibility(inputJson: Text): Text
    var
        ReceiptRef: RecordRef;
        RunField: FieldRef;
        Response: JsonObject;
        Output: Text;
    begin
        // Test-only count of permitted rows, without exposing another principal's payload.
        ReceiptRef.Open(Database::"BCD Receipt Fixture");
        ReceiptRef.SecurityFiltering(SecurityFilter::Filtered);
        RunField := ReceiptRef.Field(1);
        RunField.SetRange(ParseGuid(inputJson, 'runId'));
        Response.Add('visibleReceipts', ReceiptRef.Count());
        ReceiptRef.Close();
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure Cleanup(inputJson: Text): Text
    var
        Receipt: Record "BCD Receipt Fixture";
        Run: Record "BCD Receipt Run";
        RunId: Guid;
    begin
        RunId := ParseGuid(inputJson, 'runId');
        Receipt.SetRange("Run ID", RunId);
        Receipt.SetRange(Principal, UserSecurityId());
        if Run.Get(RunId) then begin
            CheckOwner(RunId);
            Receipt.DeleteAll();
            Run.Delete();
        end else
            if not Receipt.IsEmpty() then
                Error('BCD_E06_MISSING_RUN_OWNER');
        exit('{"cleaned":true}');
    end;

    procedure CleanState(inputJson: Text): Text
    var
        Receipt: Record "BCD Receipt Fixture";
        Run: Record "BCD Receipt Run";
        Response: JsonObject;
        RunId: Guid;
        Output: Text;
    begin
        RunId := ParseGuid(inputJson, 'runId');
        if Run.Get(RunId) then
            CheckOwner(RunId);
        Response.Add('runExists', Run.Get(RunId));
        Receipt.SetRange("Run ID", RunId);
        Receipt.SetRange(Principal, UserSecurityId());
        Response.Add('receiptCount', Receipt.Count());
        Response.WriteTo(Output);
        exit(Output);
    end;

    local procedure CheckOwner(RunId: Guid)
    var
        Run: Record "BCD Receipt Run";
    begin
        Run.Get(RunId);
        if Run.Principal <> UserSecurityId() then
            Error('BCD_E06_RUN_OWNER_MISMATCH');
    end;

    local procedure ParseGuid(Input: Text; Name: Text): Guid
    var
        Request: JsonObject;
        Token: JsonToken;
        Value: Guid;
    begin
        Request.ReadFrom(Input);
        Request.Get(Name, Token);
        if not Evaluate(Value, Token.AsValue().AsText()) then
            Error('BCD_E06_INVALID_ID');
        if IsNullGuid(Value) then
            Error('BCD_E06_INVALID_ID');
        exit(Value);
    end;
}
