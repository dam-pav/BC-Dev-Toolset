codeunit 50213 "BCD Receipt Boundary Probe"
{
    // Dedicated test app only. Caller rights apply; no Permissions property.
    procedure Execute(inputJson: Text): Text
    var
        Header: Record "BCD Probe Header";
        Request: JsonObject;
        Token: JsonToken;
        Mode: Text;
        RunId: Guid;
    begin
        RunId := ParseRunId(inputJson);
        Header.SetRange("Run ID", RunId);
        if not Header.IsEmpty() then
            Error('BCD_E07_RUN_COLLISION');
        Request.ReadFrom(inputJson);
        Request.Get('mode', Token);
        Mode := Token.AsValue().AsText();
        case Mode of
            'unguarded-explicit-error':
                RunScenario(RunId, Mode);
            'guarded-implicit-error', 'receipt-first-implicit', 'receipt-first-explicit',
            'receipt-first-ordinary', 'receipt-first-ordinary-error':
                GuardedScenario(RunId, Mode);
            'receipt-first-unguarded-implicit':
                RunScenario(RunId, Mode);
            else
                Error('BCD_E07_INVALID_MODE');
        end;
        exit('{"completed":true}');
    end;

    procedure Inspect(inputJson: Text): Text
    var
        Header: Record "BCD Probe Header";
        Response: JsonObject;
        RunId: Guid;
        Output: Text;
    begin
        RunId := ParseRunId(inputJson);
        CheckOwnership(RunId);
        Response.Add('mutation', Header.Get(RunId, 1));
        Response.Add('receipt', Header.Get(RunId, 2));
        Header.SetRange("Run ID", RunId);
        Response.Add('rowCount', Header.Count());
        Response.WriteTo(Output);
        exit(Output);
    end;

    procedure Cleanup(inputJson: Text): Text
    var
        Header: Record "BCD Probe Header";
        RunId: Guid;
    begin
        RunId := ParseRunId(inputJson);
        CheckOwnership(RunId);
        Header.SetRange("Run ID", RunId);
        Header.DeleteAll();
        exit('{"cleaned":true}');
    end;

    [CommitBehavior(CommitBehavior::Error)]
    local procedure GuardedScenario(RunId: Guid; Mode: Text)
    begin
        RunScenario(RunId, Mode);
    end;

    local procedure RunScenario(RunId: Guid; Mode: Text)
    var
        Header: Record "BCD Probe Header";
        Probe: Codeunit "BCD Commit Probe";
        ReceiptFirst: Boolean;
        BooleanRun: Boolean;
    begin
        Header.Init();
        Header."Run ID" := RunId;
        Header."Line No." := 1;
        Header."Probe Text" := 'implicit';
        if Mode in ['unguarded-explicit-error', 'receipt-first-explicit'] then
            Header."Probe Text" := 'explicit';
        ReceiptFirst := StrPos(Mode, 'receipt-first-') = 1;
        BooleanRun := Mode in ['guarded-implicit-error', 'receipt-first-implicit', 'receipt-first-unguarded-implicit'];
        if ReceiptFirst then
            InsertReceipt(RunId);
        if BooleanRun then begin
            if not Probe.Run(Header) then
                Error(GetLastErrorText());
        end else
            Probe.Run(Header);
        if not ReceiptFirst then
            InsertReceipt(RunId);
        if Mode <> 'receipt-first-ordinary' then
            Error('BCD_E07_AFTER_MUTATION');
    end;

    local procedure InsertReceipt(RunId: Guid)
    var
        Receipt: Record "BCD Probe Header";
    begin
        Receipt.Init();
        Receipt."Run ID" := RunId;
        Receipt."Line No." := 2;
        Receipt."Probe Text" := 'BCD E07 receipt';
        Receipt.Insert();
    end;

    local procedure ParseRunId(Input: Text): Guid
    var
        Request: JsonObject;
        Token: JsonToken;
        RunId: Guid;
    begin
        Request.ReadFrom(Input);
        Request.Get('runId', Token);
        if not Evaluate(RunId, Token.AsValue().AsText()) then
            Error('BCD_E07_INVALID_RUN');
        if IsNullGuid(RunId) then
            Error('BCD_E07_INVALID_RUN');
        exit(RunId);
    end;

    local procedure CheckOwnership(RunId: Guid)
    var
        Header: Record "BCD Probe Header";
    begin
        Header.SetRange("Run ID", RunId);
        if Header.FindSet() then
            repeat
                if not (((Header."Line No." = 1) and (Header."Probe Text" in ['explicit', 'implicit'])) or
                    ((Header."Line No." = 2) and (Header."Probe Text" = 'BCD E07 receipt'))) then
                    Error('BCD_E07_OWNERSHIP_CHANGED');
            until Header.Next() = 0;
    end;
}
