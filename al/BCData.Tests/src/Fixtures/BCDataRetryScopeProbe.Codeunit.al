codeunit 50220 "BCD Retry Scope Probe"
{
    // E08 fixture only; native owner/table rights, no elevated Permissions.
    procedure Prepare(inputJson: Text): Text
    begin
        exit(PrepareWithWindow(inputJson, 60000));
    end;

    procedure PrepareRestoreForTest(inputJson: Text): Text
    begin
        // Fixed 24-hour laboratory window, never a production retention setting.
        exit(PrepareWithWindow(inputJson, 86400000));
    end;

    local procedure PrepareWithWindow(inputJson: Text; WindowMs: Integer): Text
    var
        Run: Record "BCD Receipt Run";
        Response: JsonObject;
        Output: Text;
    begin
        Run."Run ID" := ReadGuid(inputJson, 'runId');
        Run.Principal := UserSecurityId();
        Run."Request Epoch" := CreateGuid();
        // Fixed test window; neither caller timestamps nor caller epochs are accepted.
        Run."Retry Until" := CurrentDateTime() + WindowMs;
        Run.Insert();
        Response.Add('scopeEpoch', Format(Run."Request Epoch", 0, 4));
        Response.Add('retryUntil', Format(Run."Retry Until", 0, 9));
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure InspectScopeForTest(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
        Response: JsonObject;
        Output: Text;
    begin
        GetOwned(Run, inputJson, false);
        Response.Add('scopeEpoch', Format(Run."Request Epoch", 0, 4));
        Response.Add('retryUntil', Format(Run."Retry Until", 0, 9));
        Response.Add('principal', Format(Run.Principal, 0, 4));
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure Validate(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
        Request: JsonObject;
        Token: JsonToken;
    begin
        GetOwned(Run, inputJson, true);
        Request.ReadFrom(inputJson);
        if IsNullGuid(Run."Request Epoch") then begin
            if Request.Get('scopeEpoch', Token) then
                Error('BCD_E08_SCOPE_RETIRED');
            exit('{"legacy":true}');
        end;
        if not Request.Get('scopeEpoch', Token) then
            Error('BCD_E08_SCOPE_REQUIRED');
        if ReadGuid(inputJson, 'scopeEpoch') <> Run."Request Epoch" then
            Error('BCD_E08_SCOPE_RETIRED');
        if (Run."Retry Until" = 0DT) or (CurrentDateTime() >= Run."Retry Until") then
            Error('BCD_E08_SCOPE_EXPIRED');
        exit('{"active":true}');
    end;

    procedure Execute(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
    begin
        GetOwned(Run, inputJson, true);
        if IsNullGuid(Run."Request Epoch") then
            Error('BCD_E08_SCOPE_RETIRED');
        Validate(inputJson);
        exit(Counter.Execute(inputJson));
    end;

    procedure Inspect(inputJson: Text): Text
    begin
        exit(Counter.Inspect(inputJson));
    end;

    procedure ExpireForTest(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
    begin
        // Explicit fixture fault injection, never a production administration API.
        GetOwnedEpoch(Run, inputJson);
        // Leave a full second for SQL DateTime rounding and immediate replay checks.
        Run."Retry Until" := CurrentDateTime() - 1000;
        Run.Modify();
        exit('{"expired":true}');
    end;

    procedure NearDeadlineForTest(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
    begin
        GetOwnedEpoch(Run, inputJson);
        Run."Retry Until" := CurrentDateTime() + 2000;
        Run.Modify();
        exit('{"nearDeadline":true}');
    end;

    procedure PurgeExpired(inputJson: Text): Text
    var
        Run: Record "BCD Receipt Run";
        Receipt: Record "BCD Receipt Fixture";
    begin
        // Scoped execution takes the same run lock before receipt reservation.
        // Purge cannot race a pending admitted request or invert that lock order.
        GetOwnedEpoch(Run, inputJson);
        if (Run."Retry Until" = 0DT) or (CurrentDateTime() < Run."Retry Until") then
            Error('BCD_E08_SCOPE_ACTIVE');
        Receipt.SetRange("Run ID", Run."Run ID");
        Receipt.SetRange(Principal, UserSecurityId());
        Receipt.DeleteAll();
        // Preserve expired epoch/deadline and all mutation state as a tombstone.
        exit(Counter.Inspect(inputJson));
    end;

    procedure Cleanup(inputJson: Text): Text
    begin
        exit(Counter.Cleanup(inputJson));
    end;

    procedure CleanState(inputJson: Text): Text
    begin
        exit(Counter.CleanState(inputJson));
    end;

    local procedure GetOwnedEpoch(var Run: Record "BCD Receipt Run"; Input: Text)
    begin
        GetOwned(Run, Input, true);
        if IsNullGuid(Run."Request Epoch") or (ReadGuid(Input, 'scopeEpoch') <> Run."Request Epoch") then
            Error('BCD_E08_SCOPE_RETIRED');
    end;

    local procedure GetOwned(var Run: Record "BCD Receipt Run"; Input: Text; Lock: Boolean)
    begin
        if Lock then
            Run.LockTable();
        if not Run.Get(ReadGuid(Input, 'runId')) then
            Error('BCD_E08_SCOPE_UNAVAILABLE');
        if Run.Principal <> UserSecurityId() then
            Error('BCD_E08_SCOPE_OWNER_MISMATCH');
    end;

    local procedure ReadGuid(Input: Text; Name: Text): Guid
    var
        Request: JsonObject;
        Token: JsonToken;
        Value: Guid;
    begin
        Request.ReadFrom(Input);
        if not Request.Get(Name, Token) then
            Error('BCD_E08_INVALID_ID');
        if not Evaluate(Value, Token.AsValue().AsText()) then
            Error('BCD_E08_INVALID_ID');
        if IsNullGuid(Value) then
            Error('BCD_E08_INVALID_ID');
        exit(Value);
    end;

    var
        Counter: Codeunit "BCD Receipt Probe";
}
